/**
 * Completed trips + payment matching for Payment Sessions (SSOT).
 * Consumes trip settlement fields and provider session amounts — no fare invention.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import type {
  AdminPaymentSessionsCompletedTripRow,
  AdminPaymentSessionsListRequest,
  AdminPaymentSessionsListRow,
  AdminPaymentSessionsMatchingRow,
  AdminPaymentSessionsSummary,
} from "../../../shared/adminPaymentSessionsSSOT.ts";
import {
  classifyPaymentTripMatch,
  type PaymentTripMatchStatus,
} from "../../../shared/paymentSessionsTripMatchSSOT.ts";
import {
  buildCaptureBreakdownForCompletedTrip,
  captureClassificationToMatchStatus,
} from "../../../shared/paymentSessionsCaptureBreakdownSSOT.ts";
import {
  confirmedCapturedRevenuePence,
  isProviderAuthorisedState,
  sumReleasedBufferTotalPence,
} from "../../../shared/paymentSessionsDisplaySSOT.ts";
import { computeCaptureAmount } from "./tripFareSSOT.ts";
import {
  buildPaymentSessionsCommissionWidgets,
  resolveTripGrossCommissionPence,
} from "../../../shared/paymentSessionsCommissionWidgetsSSOT.ts";
import type { CommissionFeeSessionInput } from "../../../shared/driverWalletCommissionFeeSSOT.ts";

export { sumReleasedBufferTotalPence };

function nullablePence(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function personName(row: {
  first_name?: string | null;
  last_name?: string | null;
} | null | undefined): string | null {
  if (!row) return null;
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

export type TripCompareBundle = {
  completed_trip_rows: AdminPaymentSessionsCompletedTripRow[];
  matching_rows: AdminPaymentSessionsMatchingRow[];
  trip_evidence_available: boolean;
  trip_evidence_message: string | null;
  compare_summary: Pick<
    AdminPaymentSessionsSummary,
    | "provider_captured_total_pence"
    | "completed_trip_fare_total_pence"
    | "matched_trips_count"
    | "capture_shortfall_pence"
    | "overcaptured_amount_pence"
    | "missing_payment_sessions_count"
    | "released_buffer_total_pence"
    | "refunded_total_pence"
    | "provider_fees_total_pence"
    | "gross_onecab_commission_pence"
    | "net_onecab_commission_pence"
    | "driver_net_total_pence"
  >;
};

export async function buildPaymentSessionsTripCompare(
  supabase: SupabaseClient,
  request: AdminPaymentSessionsListRequest,
  providerRows: AdminPaymentSessionsListRow[],
): Promise<TripCompareBundle> {
  const limit = Math.min(1000, Math.max(1, request.limit ?? 100));
  const fetchLimit = Math.min(1000, Math.max(limit * 5, 200));

  let tripQuery = supabase
    .from("trips")
    .select(
      "id, trip_code, status, completed_at, passenger_id, driver_id, service_area_id, payment_method, payment_provider, final_fare_pence, final_customer_fare_pence, commissionable_fare_pence, gross_fare_pence, locked_base_fare_pence, airport_charge_pence, tip_pence, tip_amount_pence, refund_amount_pence, pickup_waiting_charge_pence, stop_waiting_charge_pence, stop_charge_total_pence, total_waiting_charge_pence, waiting_charge_pence, no_show_charge_pence, customer_modification_charge_pence, destination_change_adjustment_pence, extras_pence, other_pass_through_charges_pence, discount_pence, commission_pence, platform_commission_amount, driver_net_pence, provider_fee_pence, driver_tier_commission_percent, provider_payment_id",
    )
    .eq("status", "completed")
    .not("completed_at", "is", null)
    .order("completed_at", { ascending: false })
    .limit(fetchLimit);

  if (request.service_area_id) tripQuery = tripQuery.eq("service_area_id", request.service_area_id);
  if (request.trip_id) tripQuery = tripQuery.eq("id", request.trip_id);
  if (request.customer_id) tripQuery = tripQuery.eq("passenger_id", request.customer_id);
  if (request.date_from) tripQuery = tripQuery.gte("completed_at", request.date_from);
  if (request.date_to) {
    const toBound = request.date_to.length <= 10
      ? `${request.date_to}T23:59:59.999Z`
      : request.date_to;
    tripQuery = tripQuery.lte("completed_at", toBound);
  }
  if (request.provider) {
    tripQuery = tripQuery.eq("payment_provider", request.provider);
  }

  const { data: trips, error: tripErr } = await tripQuery;
  if (tripErr) {
    console.warn("[admin-payment-sessions] completed trips unavailable", tripErr.message);
    const matching_rows: AdminPaymentSessionsMatchingRow[] = providerRows
      .filter((row) => row.source === "payment_sessions")
      .map((row) => ({
        id: `trip-unavailable:${row.payment_session_id ?? row.id}`,
        trip_id: row.trip_id,
        trip_code: row.trip_code,
        payment_session_id: row.payment_session_id,
        customer_name: row.customer_name,
        expected_capture_pence: null,
        actual_capture_pence: confirmedCapturedRevenuePence(row),
        authorised_amount_pence: row.authorised_amount_pence,
        released_amount_pence: row.released_amount_pence,
        variance_pence: null,
        shortfall_pence: null,
        overcapture_pence: null,
        match_status: "TRIP_EVIDENCE_UNAVAILABLE" as const,
        provider_state: row.provider_state,
        provider_verification_status: row.provider_verification_status,
        provider_order_id: row.provider_order_id,
      }));
    return {
      completed_trip_rows: [],
      matching_rows,
      trip_evidence_available: false,
      trip_evidence_message: "Trip evidence unavailable — Completed Trips Paid cannot load. Payment Matching marked TRIP_EVIDENCE_UNAVAILABLE.",
      compare_summary: emptyCompareSummary(providerRows),
    };
  }

  const tripRows = trips ?? [];
  const passengerIds = [...new Set(tripRows.map((t) => t.passenger_id).filter(Boolean))] as string[];
  const driverIds = [...new Set(tripRows.map((t) => t.driver_id).filter(Boolean))] as string[];
  const areaIds = [...new Set(tripRows.map((t) => t.service_area_id).filter(Boolean))] as string[];
  const tripIds = tripRows.map((t) => t.id as string);

  const [customersRes, driversRes, areasRes] = await Promise.all([
    passengerIds.length > 0
      ? supabase.from("customers").select("id, first_name, last_name").in("id", passengerIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    driverIds.length > 0
      ? supabase.from("drivers").select("id, first_name, last_name").in("id", driverIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    areaIds.length > 0
      ? supabase.from("service_areas").select("id, name").in("id", areaIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
  ]);

  const customerById = new Map(
    (customersRes.data ?? []).map((c) => [c.id as string, c as { first_name?: string; last_name?: string }]),
  );
  const driverById = new Map(
    (driversRes.data ?? []).map((d) => [d.id as string, d as { first_name?: string; last_name?: string }]),
  );
  const areaById = new Map(
    (areasRes.data ?? []).map((a) => [a.id as string, a as { name?: string }]),
  );

  // Prefer provider list rows; supplement with direct session lookup for trips not in window.
  const sessionByTrip = new Map<string, AdminPaymentSessionsListRow>();
  for (const row of providerRows) {
    if (!row.trip_id || row.source !== "payment_sessions") continue;
    const existing = sessionByTrip.get(row.trip_id);
    if (!existing) {
      sessionByTrip.set(row.trip_id, row);
      continue;
    }
    // Prefer row with confirmed capture evidence.
    const existingCap = confirmedCapturedRevenuePence(existing);
    const nextCap = confirmedCapturedRevenuePence(row);
    if (existingCap == null && nextCap != null) sessionByTrip.set(row.trip_id, row);
  }

  const missingTripIds = tripIds.filter((id) => !sessionByTrip.has(id));
  if (missingTripIds.length > 0) {
    const { data: sessions } = await supabase
      .from("payment_sessions")
      .select(
        "id, trip_id, payment_provider, authorised_amount_pence, captured_amount_pence, released_amount_pence, refunded_amount_pence, provider_processing_fee_pence, fee_status, provider_order_id, provider_state, provider_state_verified_at, status",
      )
      .in("trip_id", missingTripIds)
      .order("created_at", { ascending: false });

    for (const s of sessions ?? []) {
      const tripId = s.trip_id as string | null;
      if (!tripId || sessionByTrip.has(tripId)) continue;
      const verifiedAt = (s.provider_state_verified_at as string | null) ?? null;
      const age = verifiedAt ? Date.now() - Date.parse(verifiedAt) : NaN;
      const verification = !s.provider_state
        ? "UNKNOWN" as const
        : (!verifiedAt || !Number.isFinite(age) || age > 15 * 60 * 1000)
        ? "STALE" as const
        : "VERIFIED" as const;
      sessionByTrip.set(tripId, {
        id: s.id as string,
        source: "payment_sessions",
        payment_session_id: s.id as string,
        orphan_payment_id: null,
        client_action_id: null,
        created_at: "",
        customer_id: null,
        customer_name: null,
        customer_email: null,
        trip_id: tripId,
        trip_code: null,
        trip_status: null,
        driver_id: null,
        service_area_id: null,
        service_area_name: null,
        payment_provider: String(s.payment_provider ?? "unknown"),
        payment_method: null,
        purpose: "RIDE_BOOKING",
        customer_payable_pence: null,
        buffer_pence: null,
        authorised_amount_pence: nullablePence(s.authorised_amount_pence),
        captured_amount_pence: nullablePence(s.captured_amount_pence),
        released_amount_pence: nullablePence(s.released_amount_pence),
        refunded_amount_pence: nullablePence(s.refunded_amount_pence),
        provider_processing_fee_pence: nullablePence(s.provider_processing_fee_pence),
        fee_status: (s.fee_status as string | null) ?? null,
        fee_display_label: null,
        fee_display_badge: null,
        provider_order_id: (s.provider_order_id as string | null) ?? null,
        provider_payment_id: null,
        provider_capture_id: null,
        provider_state: (s.provider_state as string | null) ?? null,
        provider_state_label: null,
        provider_state_verified_at: verifiedAt,
        provider_verification_status: verification,
        session_status: (s.status as string | null) ?? null,
        session_status_display: null,
        session_status_label: null,
        technical_status: (s.status as string | null) ?? null,
        evidence_status: null,
        evidence_label: null,
        captured_at: null,
        released_at: null,
        refunded_at: null,
        release_reason: null,
        hold_terminal_reason: null,
        release_failure_reason: null,
        age_minutes: 0,
        reconciliation_status: null,
        attention_class: null,
        classification: null,
        in_active_queue: false,
        amount_display: null,
        action_policy: {
          can_create_trip: false,
          can_retry_recovery: false,
          can_release: false,
          can_capture: false,
          can_refund: false,
          can_inspect_provider: true,
          can_retry_release: false,
          can_open_trip: true,
          can_open_reconciliation: true,
        },
      });
    }
  }

  const completed_trip_rows: AdminPaymentSessionsCompletedTripRow[] = [];
  const matching_rows: AdminPaymentSessionsMatchingRow[] = [];
  const breakdownPersistQueue: Array<{
    payment_session_id: string;
    breakdown: ReturnType<typeof buildCaptureBreakdownForCompletedTrip>;
  }> = [];

  let fareTotal: number | null = null;
  let matchedCount = 0;
  let shortfallTotal: number | null = null;
  let overcaptureTotal: number | null = null;
  let missingSessions = 0;
  const commissionTripInputs: Array<{
    trip_id: string;
    trip_code: string | null;
    completed_at: string | null;
    payment_provider: string | null;
    payment_method: string | null;
    commissionable_fare_pence: number | null;
    commission_rate_percent: number | null;
    gross_commission_pence: number | null;
    provider_transaction_id: string | null;
    driver_net_pence: number | null;
  }> = [];
  const commissionSessionByTrip = new Map<string, CommissionFeeSessionInput | null>();

  for (const trip of tripRows) {
    const tripId = trip.id as string;
    const session = sessionByTrip.get(tripId) ?? null;
    const finalFare = nullablePence(
      trip.final_customer_fare_pence ?? trip.commissionable_fare_pence ?? trip.gross_fare_pence,
    );
    const rideFare = nullablePence(
      trip.final_customer_fare_pence
        ?? trip.commissionable_fare_pence
        ?? trip.locked_base_fare_pence
        ?? trip.gross_fare_pence,
    );
    const airport = nullablePence(trip.airport_charge_pence);
    const tips = nullablePence(trip.tip_pence ?? trip.tip_amount_pence);
    const pickupWaiting = nullablePence(trip.pickup_waiting_charge_pence);
    const stopWaiting = nullablePence(
      trip.stop_waiting_charge_pence ?? trip.stop_charge_total_pence,
    );
    const noShow = nullablePence(trip.no_show_charge_pence);
    const destinationChange = nullablePence(trip.destination_change_adjustment_pence);
    const manualAdj = nullablePence(trip.customer_modification_charge_pence);
    const extras = nullablePence(trip.extras_pence);
    const passThrough = nullablePence(trip.other_pass_through_charges_pence);
    const actual = session ? confirmedCapturedRevenuePence(session) : null;

    // Canonical expected = same capture path as revolutCompletionCapture (tripFareSSOT).
    const fareCapture = computeCaptureAmount(trip as Record<string, unknown>, "completed");
    const noShowForExpected = noShow ?? 0;
    const canonicalExpected = Math.max(0, fareCapture.capture_amount_pence + noShowForExpected);

    const breakdown = buildCaptureBreakdownForCompletedTrip({
      trip: trip as Record<string, unknown>,
      provider_captured_pence: actual,
      canonical_expected_capture_pence: canonicalExpected > 0 ? canonicalExpected : null,
    });

    // Persist PS-owned breakdown onto the session so FR can consume without re-deriving.
    if (session?.payment_session_id) {
      breakdownPersistQueue.push({
        payment_session_id: session.payment_session_id,
        breakdown,
      });
    }

    const breakdownMatchStatus = captureClassificationToMatchStatus(breakdown.capture_classification);
    const match = classifyPaymentTripMatch({
      expected_capture_pence: breakdown.expected_capture_pence,
      actual_capture_pence: actual,
      has_payment_session: Boolean(session?.payment_session_id),
      has_trip_link: true,
      trip_evidence_available: true,
      provider_verification_status: session?.provider_verification_status ?? null,
      provider_state: session?.provider_state ?? null,
      provider_state_pending: session
        ? isProviderAuthorisedState(session.provider_state)
          && actual == null
        : false,
      authorised_amount_pence: session?.authorised_amount_pence ?? null,
      actual_released_pence: session?.released_amount_pence ?? null,
      expected_refund_pence: nullablePence(trip.refund_amount_pence),
      actual_refund_pence: session?.refunded_amount_pence ?? null,
    });

    // Prefer breakdown classification for capture amount compare; keep release/refund match overrides.
    const matchStatus: PaymentTripMatchStatus =
      match.status === "RELEASE_MISMATCH"
      || match.status === "REFUND_MISMATCH"
      || match.status === "NO_PAYMENT_SESSION"
      || match.status === "CAPTURE_MISSING"
      || match.status === "CAPTURE_EVIDENCE_PENDING"
      || match.status === "PROVIDER_STATE_PENDING"
      || match.status === "PROVIDER_VERIFICATION_PENDING"
      || match.status === "TRIP_FARE_UNAVAILABLE"
        ? match.status
        : breakdownMatchStatus === "UNEXPLAINED_OVERCAPTURE"
        ? "UNEXPLAINED_OVERCAPTURE"
        : breakdownMatchStatus === "OVERCAPTURE"
        ? "UNEXPLAINED_OVERCAPTURE"
        : breakdownMatchStatus === "MATCHED"
        ? "MATCHED"
        : match.status;

    const expected = breakdown.expected_capture_pence;
    const waitingTotal =
      (pickupWaiting ?? 0) + (stopWaiting ?? 0) > 0
        ? (pickupWaiting ?? 0) + (stopWaiting ?? 0)
        : null;
    const otherComponents =
      (airport ?? 0)
        + (extras ?? 0)
        + (manualAdj ?? 0)
        + (destinationChange ?? 0)
        + (passThrough ?? 0)
        + (noShow ?? 0);
    const otherPaymentComponentsPence = otherComponents > 0 ? otherComponents : null;

    if (expected != null) fareTotal = (fareTotal ?? 0) + expected;
    if (matchStatus === "MATCHED") matchedCount += 1;
    if (matchStatus === "NO_PAYMENT_SESSION") missingSessions += 1;
    if (matchStatus === "CAPTURE_SHORTFALL" && breakdown.variance_pence != null && breakdown.variance_pence < 0) {
      shortfallTotal = (shortfallTotal ?? 0) + Math.abs(breakdown.variance_pence);
    }
    if (matchStatus === "UNEXPLAINED_OVERCAPTURE" || matchStatus === "OVERCAPTURE") {
      if (breakdown.variance_pence != null && breakdown.variance_pence > 0) {
        overcaptureTotal = (overcaptureTotal ?? 0) + breakdown.variance_pence;
      }
    }

    const varianceDisplay = breakdown.variance_pence ?? match.variance_pence;

    commissionTripInputs.push({
      trip_id: tripId,
      trip_code: (trip.trip_code as string | null) ?? null,
      completed_at: (trip.completed_at as string | null) ?? null,
      payment_provider: (trip.payment_provider as string | null) ?? null,
      payment_method: (trip.payment_method as string | null) ?? null,
      commissionable_fare_pence: finalFare,
      commission_rate_percent: trip.driver_tier_commission_percent == null
        ? null
        : Number(trip.driver_tier_commission_percent),
      gross_commission_pence: resolveTripGrossCommissionPence(trip as Record<string, unknown>),
      provider_transaction_id: (trip.provider_payment_id as string | null) ?? null,
      driver_net_pence: nullablePence(trip.driver_net_pence),
    });
    if (session) {
      commissionSessionByTrip.set(tripId, {
        payment_session_id: session.payment_session_id,
        payment_provider: session.payment_provider,
        payment_method: session.payment_method,
        provider_processing_fee_pence: session.provider_processing_fee_pence,
        fee_status: session.fee_status,
        provider_transaction_id: session.provider_payment_id ?? session.provider_order_id,
      });
    }

    completed_trip_rows.push({
      id: tripId,
      trip_id: tripId,
      trip_code: (trip.trip_code as string | null) ?? null,
      completed_at: (trip.completed_at as string | null) ?? null,
      customer_id: (trip.passenger_id as string | null) ?? null,
      customer_name: personName(customerById.get(String(trip.passenger_id ?? ""))),
      driver_id: (trip.driver_id as string | null) ?? null,
      driver_name: personName(driverById.get(String(trip.driver_id ?? ""))),
      service_area_id: (trip.service_area_id as string | null) ?? null,
      service_area_name: areaById.get(String(trip.service_area_id ?? ""))?.name ?? null,
      final_customer_fare_pence: finalFare,
      ride_fare_pence: rideFare,
      airport_charge_pence: airport,
      tips_pence: tips,
      pickup_waiting_charge_pence: pickupWaiting,
      stop_waiting_charge_pence: stopWaiting,
      waiting_charges_pence: waitingTotal,
      other_payment_components_pence: otherPaymentComponentsPence,
      no_show_charge_pence: noShow,
      expected_capture_pence: expected,
      payment_session_id: session?.payment_session_id ?? null,
      payment_provider: session?.payment_provider
        ?? (trip.payment_provider as string | null)
        ?? null,
      provider_captured_pence: actual,
      provider_released_pence: session?.released_amount_pence ?? null,
      shortfall_overcapture_pence: varianceDisplay,
      variance_pence: breakdown.variance_pence,
      variance_reason: breakdown.variance_reason,
      capture_classification: breakdown.capture_classification,
      match_status: matchStatus,
      capture_breakdown: breakdown,
    });

    matching_rows.push({
      id: `${tripId}:${session?.payment_session_id ?? "none"}`,
      trip_id: tripId,
      trip_code: (trip.trip_code as string | null) ?? null,
      payment_session_id: session?.payment_session_id ?? null,
      customer_name: personName(customerById.get(String(trip.passenger_id ?? ""))),
      expected_capture_pence: expected,
      actual_capture_pence: actual,
      authorised_amount_pence: session?.authorised_amount_pence ?? null,
      released_amount_pence: session?.released_amount_pence ?? null,
      variance_pence: breakdown.variance_pence ?? match.variance_pence,
      shortfall_pence: matchStatus === "CAPTURE_SHORTFALL" && breakdown.variance_pence != null
        ? Math.abs(breakdown.variance_pence)
        : match.shortfall_pence,
      overcapture_pence: matchStatus === "UNEXPLAINED_OVERCAPTURE" && breakdown.variance_pence != null
        ? breakdown.variance_pence
        : null,
      variance_reason: breakdown.variance_reason,
      capture_classification: breakdown.capture_classification,
      match_status: matchStatus,
      provider_state: session?.provider_state ?? null,
      provider_verification_status: session?.provider_verification_status ?? null,
      provider_order_id: session?.provider_order_id ?? null,
    });
  }

  // Sessions without trip link (matching view completeness).
  for (const row of providerRows) {
    if (row.source !== "payment_sessions") continue;
    if (row.trip_id && sessionByTrip.has(row.trip_id)) continue;
    if (row.trip_id && tripIds.includes(row.trip_id)) continue;
    if (!row.trip_id) {
      const match = classifyPaymentTripMatch({
        expected_capture_pence: null,
        actual_capture_pence: confirmedCapturedRevenuePence(row),
        has_payment_session: true,
        has_trip_link: false,
        trip_evidence_available: true,
        provider_verification_status: row.provider_verification_status,
      });
      matching_rows.push({
        id: `session:${row.payment_session_id ?? row.id}`,
        trip_id: null,
        trip_code: null,
        payment_session_id: row.payment_session_id,
        customer_name: row.customer_name,
        expected_capture_pence: null,
        actual_capture_pence: confirmedCapturedRevenuePence(row),
        authorised_amount_pence: row.authorised_amount_pence,
        released_amount_pence: row.released_amount_pence,
        variance_pence: match.variance_pence,
        shortfall_pence: match.shortfall_pence,
        overcapture_pence: match.overcapture_pence,
        match_status: match.status,
        provider_state: row.provider_state,
        provider_verification_status: row.provider_verification_status,
        provider_order_id: row.provider_order_id,
      });
    }
  }

  const matchFilter = request.match_status ?? null;
  const filteredCompleted = matchFilter
    ? completed_trip_rows.filter((r) => r.match_status === matchFilter)
    : completed_trip_rows;
  const filteredMatching = matchFilter
    ? matching_rows.filter((r) => r.match_status === matchFilter)
    : matching_rows;

  // Persist capture breakdown onto payment_sessions.metadata (PS owns; FR consumes).
  if (breakdownPersistQueue.length > 0) {
    await Promise.all(
      breakdownPersistQueue.slice(0, 100).map(async ({ payment_session_id, breakdown }) => {
        const { data: existing } = await supabase
          .from("payment_sessions")
          .select("metadata")
          .eq("id", payment_session_id)
          .maybeSingle();
        const prev = (existing?.metadata && typeof existing.metadata === "object")
          ? existing.metadata as Record<string, unknown>
          : {};
        const prevBreakdown = prev.capture_breakdown as Record<string, unknown> | undefined;
        if (
          prevBreakdown
          && prevBreakdown.expected_capture_pence === breakdown.expected_capture_pence
          && prevBreakdown.provider_captured_pence === breakdown.provider_captured_pence
          && prevBreakdown.capture_classification === breakdown.capture_classification
          && prevBreakdown.variance_pence === breakdown.variance_pence
        ) {
          return;
        }
        const { error } = await supabase
          .from("payment_sessions")
          .update({
            metadata: {
              ...prev,
              capture_breakdown: breakdown,
              capture_breakdown_at: new Date().toISOString(),
            },
          })
          .eq("id", payment_session_id);
        if (error) {
          console.warn(
            "[admin-payment-sessions] capture_breakdown persist failed",
            payment_session_id,
            error.message,
          );
        }
      }),
    );
  }

  const commissionWidgets = buildPaymentSessionsCommissionWidgets({
    trips: commissionTripInputs,
    sessionByTripId: commissionSessionByTrip,
  });

  return {
    completed_trip_rows: filteredCompleted,
    matching_rows: filteredMatching,
    trip_evidence_available: true,
    trip_evidence_message: null,
    compare_summary: {
      ...emptyCompareSummary(providerRows),
      completed_trip_fare_total_pence: fareTotal,
      matched_trips_count: matchedCount,
      capture_shortfall_pence: shortfallTotal,
      overcaptured_amount_pence: overcaptureTotal,
      missing_payment_sessions_count: missingSessions,
      gross_onecab_commission_pence: commissionWidgets.gross_onecab_commission_pence,
      net_onecab_commission_pence: commissionWidgets.net_onecab_commission_pence,
      driver_net_total_pence: commissionWidgets.driver_net_total_pence,
    },
  };
}

function emptyCompareSummary(
  providerRows: AdminPaymentSessionsListRow[],
): TripCompareBundle["compare_summary"] {
  let providerCaptured: number | null = null;
  let refundedTotal: number | null = null;
  let feesTotal: number | null = null;

  for (const row of providerRows) {
    const cap = confirmedCapturedRevenuePence(row);
    if (cap != null) providerCaptured = (providerCaptured ?? 0) + cap;
    if (row.refunded_amount_pence != null) {
      const n = Number(row.refunded_amount_pence);
      if (Number.isFinite(n) && n >= 0) refundedTotal = (refundedTotal ?? 0) + Math.round(n);
    }
    if (row.provider_processing_fee_pence != null) {
      const badge = String(row.fee_display_badge ?? "").toUpperCase();
      const feeStatus = String(row.fee_status ?? "").toUpperCase();
      // Provider Fees widget = confirmed ACTUAL fees only (never estimated/pending).
      if (badge !== "ACTUAL" && feeStatus !== "ACTUAL") continue;
      const n = Number(row.provider_processing_fee_pence);
      if (Number.isFinite(n) && n >= 0) feesTotal = (feesTotal ?? 0) + Math.round(n);
    }
  }

  return {
    provider_captured_total_pence: providerCaptured,
    completed_trip_fare_total_pence: null,
    matched_trips_count: 0,
    capture_shortfall_pence: null,
    overcaptured_amount_pence: null,
    missing_payment_sessions_count: 0,
    released_buffer_total_pence: sumReleasedBufferTotalPence(providerRows),
    refunded_total_pence: refundedTotal,
    provider_fees_total_pence: feesTotal,
    gross_onecab_commission_pence: null,
    net_onecab_commission_pence: null,
    driver_net_total_pence: null,
  };
}

export function filterMatchStatus(
  status: PaymentTripMatchStatus | null | undefined,
  rows: AdminPaymentSessionsMatchingRow[],
): AdminPaymentSessionsMatchingRow[] {
  if (!status) return rows;
  return rows.filter((r) => r.match_status === status);
}
