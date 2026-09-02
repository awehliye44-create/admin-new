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
  confirmedCapturedRevenuePence,
  isProviderAuthorisedState,
  sumReleasedBufferTotalPence,
} from "../../../shared/paymentSessionsDisplaySSOT.ts";
import {
  buildCanonicalTripEconomicsRead,
  resolveOtherNonModComponentsPence,
} from "../../../shared/paymentSessionsCanonicalReadAdapterSSOT.ts";
import {
  buildPaymentSessionsCommissionWidgets,
  resolveTripGrossCommissionPence,
} from "../../../shared/paymentSessionsCommissionWidgetsSSOT.ts";
import type { CommissionFeeSessionInput } from "../../../shared/driverWalletCommissionFeeSSOT.ts";
import { FINANCIAL_MODEL } from "../../../shared/financialModelScopeSSOT.ts";

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
    | "gross_overcapture_pence"
    | "resolved_overcapture_pence"
    | "outstanding_customer_overcharge_pence"
    | "refund_beyond_gross_overcapture_pence"
    | "fr_match_chips_available"
    | "fr_match_chips_message"
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
  const tab = request.tab ?? "overview";
  const detailRows = tab === "completed_trips_paid" || tab === "payment_matching";
  const limit = Math.min(1000, Math.max(1, request.limit ?? 100));
  const offset = Math.max(0, Number(request.offset ?? 0));
  // Overview KPIs: smaller completed-trip window, no name joins.
  const fetchLimit = offset > 0
    ? limit
    : detailRows
      ? Math.min(1000, Math.max(limit * 5, 200))
      : Math.min(300, Math.max(limit * 2, 100));

  let tripQuery = supabase
    .from("trips")
    .select(
      "id, trip_code, status, completed_at, passenger_id, driver_id, service_area_id, financial_model, commission_wallet_enabled, payment_method, payment_provider, final_fare_pence, final_customer_fare_pence, commissionable_fare_pence, gross_fare_pence, locked_base_fare_pence, airport_charge_pence, tip_pence, tip_amount_pence, refund_amount_pence, pickup_waiting_charge_pence, stop_waiting_charge_pence, stop_charge_total_pence, total_waiting_charge_pence, waiting_charge_pence, no_show_charge_pence, customer_modification_charge_pence, destination_change_adjustment_pence, extras_pence, other_pass_through_charges_pence, discount_pence, commission_pence, platform_commission_amount, driver_net_pence, provider_fee_pence, accepted_commission_percent, driver_tier_commission_percent, provider_payment_id, accepted_preset_offer_fare_pence, accepted_driver_offer_fare_pence, locked_offer_type",
    )
    // PIPELINE 1 — Payment Sessions never loads DRIVER_COLLECTED_COMMISSION_WALLET trips.
    .eq("financial_model", FINANCIAL_MODEL.PLATFORM_COLLECTED)
    .eq("status", "completed")
    .not("completed_at", "is", null)
    .order("completed_at", { ascending: false });

  if (offset > 0) {
    tripQuery = tripQuery.range(offset, offset + fetchLimit - 1);
  } else {
    tripQuery = tripQuery.limit(fetchLimit);
  }

  if (request.service_area_id) {
    tripQuery = tripQuery.eq("service_area_id", request.service_area_id);
  } else if (request.allowed_service_area_ids && request.allowed_service_area_ids.length > 0) {
    tripQuery = tripQuery.in("service_area_id", request.allowed_service_area_ids);
  } else if (request.allowed_service_area_ids && request.allowed_service_area_ids.length === 0) {
    // No PLATFORM service areas configured — return empty compare universe.
    tripQuery = tripQuery.eq("service_area_id", "00000000-0000-0000-0000-000000000000");
  }
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
  const tripIds = tripRows.map((t) => t.id as string);

  const customerById = new Map<string, { first_name?: string; last_name?: string }>();
  const driverById = new Map<string, { first_name?: string; last_name?: string }>();
  const areaById = new Map<string, { name?: string }>();

  if (detailRows) {
    const passengerIds = [...new Set(tripRows.map((t) => t.passenger_id).filter(Boolean))] as string[];
    const driverIds = [...new Set(tripRows.map((t) => t.driver_id).filter(Boolean))] as string[];
    const areaIds = [...new Set(tripRows.map((t) => t.service_area_id).filter(Boolean))] as string[];
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
    for (const c of customersRes.data ?? []) {
      customerById.set(c.id as string, c as { first_name?: string; last_name?: string });
    }
    for (const d of driversRes.data ?? []) {
      driverById.set(d.id as string, d as { first_name?: string; last_name?: string });
    }
    for (const a of areasRes.data ?? []) {
      areaById.set(a.id as string, a as { name?: string });
    }
  }

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

  const missingTripIds = detailRows
    ? tripIds.filter((id) => !sessionByTrip.has(id))
    : [];
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
        release_evidence_status: null,
        release_evidence_source: null,
        release_verified_at: null,
        payment_resolution_status: null,
        recovery_required: null,
        age_minutes: 0,
        reconciliation_status: null,
        capture_classification: null,
        capture_classification_label: null,
        difference_pence: null,
        outstanding_pence: null,
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

  let fareTotal: number | null = null;
  let missingSessions = 0;
  // FR-owned chip aggregates stay null until FR persists per-session match.
  // Rows may still show stamp↔PS variance for display (owned fields only).
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
    const economics = buildCanonicalTripEconomicsRead(trip as Record<string, unknown>);
    const actual = session ? confirmedCapturedRevenuePence(session) : null;
    const expected = economics.expected_capture_pence;

    // Presence / lifecycle matching only — never invent amount FR conclusions.
    const match = classifyPaymentTripMatch({
      expected_capture_pence: expected,
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
      expected_refund_pence: null,
      actual_refund_pence: session?.refunded_amount_pence ?? null,
    });

    /**
     * Presence / lifecycle only — never classify shortfall/overcapture/matched here.
     * FR owns amount reconciliation.
     */
    const presenceLifecycleStatuses = new Set<PaymentTripMatchStatus>([
      "RELEASE_MISMATCH",
      "REFUND_MISMATCH",
      "NO_PAYMENT_SESSION",
      "CAPTURE_MISSING",
      "CAPTURE_EVIDENCE_PENDING",
      "PROVIDER_STATE_PENDING",
      "PROVIDER_VERIFICATION_PENDING",
      "TRIP_FARE_UNAVAILABLE",
      "NO_TRIP_LINK",
      "TRIP_EVIDENCE_UNAVAILABLE",
    ]);
    // Never emit null — older Completed Trips UI called status.includes(…) and crashed.
    // Amount MATCHED/SHORTFALL/OVERCAPTURE stay FR-owned via AMOUNTS_ON_FR (not invented here).
    const matchStatus: PaymentTripMatchStatus = presenceLifecycleStatuses.has(match.status)
      ? match.status
      : "AMOUNTS_ON_FR";

    const otherPaymentComponentsPence = resolveOtherNonModComponentsPence(
      trip as Record<string, unknown>,
    );

    if (economics.final_fare_pence != null) {
      fareTotal = (fareTotal ?? 0) + economics.final_fare_pence;
    }
    // missing_sessions is PS presence (owned), not an FR classification chip.
    if (matchStatus === "NO_PAYMENT_SESSION") missingSessions += 1;

    commissionTripInputs.push({
      trip_id: tripId,
      trip_code: (trip.trip_code as string | null) ?? null,
      completed_at: (trip.completed_at as string | null) ?? null,
      payment_provider: (trip.payment_provider as string | null) ?? null,
      payment_method: (trip.payment_method as string | null) ?? null,
      // Settlement stamp — never derive from capture or final_customer alone.
      commissionable_fare_pence: economics.commissionable_fare_pence,
      commission_rate_percent: economics.commission_percent,
      gross_commission_pence: resolveTripGrossCommissionPence(trip as Record<string, unknown>),
      provider_transaction_id: (trip.provider_payment_id as string | null) ?? null,
      driver_net_pence: economics.driver_net_pence,
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

    if (!detailRows) continue;

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
      final_customer_fare_pence: economics.final_customer_payable_pence,
      ride_fare_pence: economics.final_customer_payable_pence,
      final_fare_pence: economics.final_fare_pence,
      original_locked_fare_pence: economics.original_locked_fare_pence,
      accepted_preset_offer_fare_pence: economics.accepted_preset_offer_fare_pence,
      airport_charge_pence: economics.airport_pence,
      tips_pence: economics.tip_pence,
      pickup_waiting_charge_pence: economics.pickup_waiting_pence,
      stop_waiting_charge_pence: economics.stop_waiting_pence,
      waiting_charges_pence: economics.waiting_total_pence,
      other_payment_components_pence: otherPaymentComponentsPence,
      no_show_charge_pence: nullablePence(trip.no_show_charge_pence),
      modification_audit_pence: economics.modification_audit_pence,
      commissionable_fare_pence: economics.commissionable_fare_pence,
      commission_pence: economics.commission_pence,
      driver_net_pence: economics.driver_net_pence,
      expected_capture_pence: expected,
      payment_session_id: session?.payment_session_id ?? null,
      payment_provider: session?.payment_provider
        ?? (trip.payment_provider as string | null)
        ?? null,
      provider_captured_pence: actual,
      provider_released_pence: session?.released_amount_pence ?? null,
      provider_refunded_pence: session?.refunded_amount_pence ?? null,
      // FR-owned — null until FR persists per-session conclusions.
      shortfall_overcapture_pence: null,
      variance_pence: null,
      variance_reason: null,
      capture_classification: null,
      match_status: matchStatus,
      match_classification_source: "ps_presence_lifecycle",
      fr_match_status_persisted: false,
      capture_breakdown: null,
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
      variance_pence: null,
      shortfall_pence: null,
      overcapture_pence: null,
      refunded_amount_pence: session?.refunded_amount_pence ?? null,
      outstanding_overcharge_pence: null,
      resolved_overcapture_pence: null,
      refund_beyond_gross_overcapture_pence: null,
      variance_reason: null,
      capture_classification: null,
      match_status: matchStatus,
      provider_state: session?.provider_state ?? null,
      provider_verification_status: session?.provider_verification_status ?? null,
      provider_order_id: session?.provider_order_id ?? null,
    });
  }

  // Sessions without trip link (matching view completeness) — detail tabs only.
  if (detailRows) {
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
        variance_pence: null,
        shortfall_pence: null,
        overcapture_pence: null,
        match_status: match.status === "NO_TRIP_LINK" ? match.status : "NO_TRIP_LINK",
        provider_state: row.provider_state,
        provider_verification_status: row.provider_verification_status,
        provider_order_id: row.provider_order_id,
      });
    }
  }
  }

  const matchFilter = request.match_status ?? null;
  const filteredCompleted = matchFilter
    ? completed_trip_rows.filter((r) => rowMatchesOwnedFieldFilter(matchFilter, r))
    : completed_trip_rows;
  const filteredMatching = matchFilter
    ? matching_rows.filter((r) => rowMatchesOwnedFieldFilter(matchFilter, r))
    : matching_rows;

  // Read-path only: do not persist capture_breakdown on list (write side-effect removed).

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
      // FR owns match/shortfall/overcapture chips — unavailable on PS until FR persists them.
      matched_trips_count: null,
      capture_shortfall_pence: null,
      overcaptured_amount_pence: null,
      gross_overcapture_pence: null,
      resolved_overcapture_pence: null,
      outstanding_customer_overcharge_pence: null,
      refund_beyond_gross_overcapture_pence: null,
      fr_match_chips_available: false,
      fr_match_chips_message:
        "FR does not persist per-session match for Payment Sessions. Open Financial Reconciliation for audit conclusions.",
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
    // Provider Fees chip = confirmed ACTUAL fees only.
    // Amount present + null fee_status (common after capture) counts as ACTUAL.
    // PENDING / ESTIMATED / UNAVAILABLE contribute 0.
    if (row.provider_processing_fee_pence == null) continue;
    const badge = String(row.fee_display_badge ?? "").toUpperCase();
    const feeStatus = String(row.fee_status ?? "").toUpperCase();
    if (
      badge === "PENDING"
      || feeStatus === "PENDING"
      || badge === "ESTIMATED"
      || feeStatus === "ESTIMATED"
      || badge === "UNAVAILABLE"
      || feeStatus === "UNAVAILABLE"
    ) {
      continue;
    }
    const n = Number(row.provider_processing_fee_pence);
    if (Number.isFinite(n) && n >= 0) feesTotal = (feesTotal ?? 0) + Math.round(n);
  }

  return {
    provider_captured_total_pence: providerCaptured,
    completed_trip_fare_total_pence: null,
    matched_trips_count: null,
    capture_shortfall_pence: null,
    overcaptured_amount_pence: null,
    gross_overcapture_pence: null,
    resolved_overcapture_pence: null,
    outstanding_customer_overcharge_pence: null,
    refund_beyond_gross_overcapture_pence: null,
    fr_match_chips_available: false,
    fr_match_chips_message:
      "FR does not persist per-session match for Payment Sessions. Open Financial Reconciliation for audit conclusions.",
    missing_payment_sessions_count: 0,
    released_buffer_total_pence: sumReleasedBufferTotalPence(providerRows),
    refunded_total_pence: refundedTotal,
    provider_fees_total_pence: feesTotal,
    gross_onecab_commission_pence: null,
    net_onecab_commission_pence: null,
    driver_net_total_pence: null,
  };
}

/** PS-money compare summary only (no Trip Fare / Settlement trip scan). */
export function buildPsOnlyCompareSummary(
  providerRows: AdminPaymentSessionsListRow[],
): TripCompareBundle["compare_summary"] {
  return emptyCompareSummary(providerRows);
}

export function filterMatchStatus(
  status: PaymentTripMatchStatus | null | undefined,
  rows: AdminPaymentSessionsMatchingRow[],
): AdminPaymentSessionsMatchingRow[] {
  if (!status) return rows;
  return rows.filter((r) => rowMatchesOwnedFieldFilter(status, r));
}

/**
 * Tab filter only.
 * Amount MATCHED / SHORTFALL / OVERCAPTURE are FR-owned — never invent from local variance.
 * Presence / lifecycle filters use match_status.
 */
export function rowMatchesOwnedFieldFilter(
  filter: PaymentTripMatchStatus,
  row: { match_status?: PaymentTripMatchStatus | null; variance_pence?: number | null },
): boolean {
  if (
    filter === "MATCHED"
    || filter === "CAPTURE_SHORTFALL"
    || filter === "UNEXPLAINED_OVERCAPTURE"
    || filter === "OVERCAPTURE"
  ) {
    // FR does not persist these on PS rows — do not reconstruct via variance_pence.
    return false;
  }
  return row.match_status === filter;
}
