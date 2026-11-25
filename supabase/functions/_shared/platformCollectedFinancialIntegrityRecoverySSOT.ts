/**
 * #92H — Generic PLATFORM_COLLECTED financial integrity recovery (evidence-only).
 *
 * Covers every applicable completed/captured PC trip, not a single case ID.
 * Never POSTs CAPTURE/INCREMENT. Never creates a second TEN.
 * Never applies abandoned trip modifications.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { writePayableSnapshotOrLog } from "./writePayableSnapshotOrLogSSOT.ts";
import { reconcileIncrementOperationsToCoverConfirmed } from "./reconcileFinancialOperationFromEvidenceSSOT.ts";
import { terminalizeAbandonedTripChangeRequests } from "./terminalizeAbandonedModificationSSOT.ts";
import { buildTripPaymentProjectionAfterCapture } from "./paymentSessionsCaptureConfirmationSSOT.ts";
import { isConfirmedIncrementRowStatus } from "./revolutIncrementAuthorisationSSOT.ts";
import { SERVICE_AREA_FINANCIAL_MODEL } from "./commissionWalletSSOT.ts";
import { recordPaymentFinancialEvent } from "./paymentFinancialDiagnosticsSSOT.ts";

export type IntegrityRecoveryTripResult = {
  trip_id: string;
  trip_code: string | null;
  snapshots_written: number;
  increment_ops_reconciled: number;
  coverage_stamped: boolean;
  tcr_terminalized: number;
  skipped_reason?: string;
};

function isPlatformCollected(model: unknown): boolean {
  const m = String(model ?? "").toUpperCase();
  return m === "PLATFORM_COLLECTED"
    || m === SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED;
}

function nonNegPence(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * #92K — Booking-time payable evidence from the payment session only.
 * Never read trips.* fares here (may include modifications / waiting / tips).
 */
export async function resolveBookingTimePayableEvidence(
  supabase: SupabaseClient,
  args: { paymentSessionId?: string | null },
): Promise<
  | {
    ok: true;
    grossFarePence: number;
    discountPence: number;
    airportPence: number;
    currency: string;
  }
  | { ok: false; reason: string }
> {
  const sessionId = String(args.paymentSessionId ?? "").trim();
  if (!sessionId) return { ok: false, reason: "missing_payment_session_id" };

  const { data: session, error } = await supabase
    .from("payment_sessions")
    .select(
      "estimated_total_pence, fare_snapshot, booking_snapshot, currency, buffer_pence",
    )
    .eq("id", sessionId)
    .maybeSingle();
  if (error) return { ok: false, reason: `session_read_failed:${error.message}` };
  if (!session) return { ok: false, reason: "payment_session_not_found" };

  const fareSnap = (session.fare_snapshot && typeof session.fare_snapshot === "object")
    ? session.fare_snapshot as Record<string, unknown>
    : {};
  const bookSnap = (session.booking_snapshot && typeof session.booking_snapshot === "object")
    ? session.booking_snapshot as Record<string, unknown>
    : {};

  const gross = nonNegPence(fareSnap.gross_fare_pence)
    || nonNegPence(fareSnap.final_fare_pence)
    || nonNegPence(fareSnap.estimated_total_pence)
    || nonNegPence(session.estimated_total_pence)
    || nonNegPence(bookSnap.gross_fare_pence)
    || nonNegPence(bookSnap.final_estimated_fare_pence);
  if (gross <= 0) return { ok: false, reason: "booking_time_gross_unavailable" };

  const discount = nonNegPence(fareSnap.offer_discount_pence)
    || nonNegPence(bookSnap.discount_amount_pence)
    || nonNegPence(bookSnap.offer_discount_pence);
  const airport = nonNegPence(fareSnap.airport_charge_pence)
    || nonNegPence(bookSnap.airport_charge_pence);
  const currency = String(
    session.currency
      ?? fareSnap.currency
      ?? bookSnap.currency_code
      ?? "GBP",
  );

  return {
    ok: true,
    grossFarePence: gross,
    discountPence: discount,
    airportPence: airport,
    currency,
  };
}

/**
 * Recover durable integrity gaps for one PLATFORM_COLLECTED trip after
 * provider-confirmed capture. Idempotent.
 */
export async function recoverPlatformCollectedTripFinancialIntegrity(
  supabase: SupabaseClient,
  args: { tripId: string },
): Promise<IntegrityRecoveryTripResult> {
  const tripId = String(args.tripId).trim();
  const empty: IntegrityRecoveryTripResult = {
    trip_id: tripId,
    trip_code: null,
    snapshots_written: 0,
    increment_ops_reconciled: 0,
    coverage_stamped: false,
    tcr_terminalized: 0,
  };
  if (!tripId) return { ...empty, skipped_reason: "missing_trip_id" };

  const { data: trip } = await supabase
    .from("trips")
    .select(
      "id, trip_code, status, financial_model, payment_status, payment_coverage_status, "
        + "payment_session_id, locked_base_fare_pence, final_customer_fare_pence, "
        + "final_fare_pence, gross_fare_pence, capture_amount_pence, tip_pence, tip_amount_pence, "
        + "pickup_waiting_charge_pence, stop_waiting_charge_pence, offer_discount_pence, "
        + "voucher_discount_pence, airport_charge_pence, other_pass_through_charges_pence, "
        + "currency_code, customer_modification_charge_pence, modification_delta_pence",
    )
    .eq("id", tripId)
    .maybeSingle();

  if (!trip) return { ...empty, skipped_reason: "trip_not_found" };
  empty.trip_code = trip.trip_code ? String(trip.trip_code) : null;

  if (!isPlatformCollected(trip.financial_model)) {
    return { ...empty, skipped_reason: "not_platform_collected" };
  }
  if (String(trip.status ?? "").toLowerCase() !== "completed") {
    return { ...empty, skipped_reason: "not_completed" };
  }
  if (String(trip.payment_status ?? "").toLowerCase() !== "captured") {
    return { ...empty, skipped_reason: "not_captured" };
  }

  const sessionId = String(trip.payment_session_id ?? "").trim();
  const capturedPence = Math.max(
    0,
    Math.round(Number(trip.capture_amount_pence) || 0),
  );

  // ── Snapshots: booking baseline + at least one completion/recovery row ────
  // MK-261125-006: completion snap alone must not hide a missing booking snap.
  let snapshotsWritten = 0;
  const tripSnapRow = {
    locked_base_fare_pence: trip.locked_base_fare_pence,
    final_customer_fare_pence: trip.final_customer_fare_pence,
    final_fare_pence: trip.final_fare_pence,
    gross_fare_pence: trip.gross_fare_pence,
    customer_modification_charge_pence: trip.customer_modification_charge_pence,
    modification_delta_pence: trip.modification_delta_pence,
    pickup_waiting_charge_pence: trip.pickup_waiting_charge_pence,
    stop_waiting_charge_pence: trip.stop_waiting_charge_pence,
    offer_discount_pence: trip.offer_discount_pence,
    voucher_discount_pence: trip.voucher_discount_pence,
    airport_charge_pence: trip.airport_charge_pence,
    other_pass_through_charges_pence: trip.other_pass_through_charges_pence,
    tip_pence: trip.tip_pence,
    tip_amount_pence: trip.tip_amount_pence,
    currency_code: trip.currency_code,
  };
  const { count: bookingSnapCount } = await supabase
    .from("payment_payable_snapshots")
    .select("id", { count: "exact", head: true })
    .eq("trip_id", tripId)
    .eq("source", "booking");
  if ((bookingSnapCount ?? 0) === 0) {
    // #92K — Never invent booking amounts from current trip columns (may include
    // post-booking modifications / waiting / tips). Use payment_sessions
    // booking-time evidence only; fail observable if absent.
    const bookingEvidence = await resolveBookingTimePayableEvidence(supabase, {
      paymentSessionId: sessionId || null,
    });
    if (!bookingEvidence.ok) {
      // Observable gap only — never fabricate a booking snap from modified trip fares.
      await recordPaymentFinancialEvent(supabase, {
        paymentSessionId: sessionId || null,
        tripId,
        opType: "RECONCILE",
        eventType: "payable_snapshot_booking_gap_unrecoverable",
        detail: {
          reason: bookingEvidence.reason,
          note: "refused_to_fabricate_from_modified_trip_fares",
        },
      }).catch(() => undefined);
    } else {
      const bookingGap = await writePayableSnapshotOrLog(supabase, {
        tripId,
        trip: {
          locked_base_fare_pence: bookingEvidence.grossFarePence,
          gross_fare_pence: bookingEvidence.grossFarePence,
          final_customer_fare_pence: bookingEvidence.grossFarePence,
          final_fare_pence: bookingEvidence.grossFarePence,
          tip_pence: 0,
          tip_amount_pence: 0,
          pickup_waiting_charge_pence: 0,
          stop_waiting_charge_pence: 0,
          offer_discount_pence: bookingEvidence.discountPence,
          voucher_discount_pence: 0,
          airport_charge_pence: bookingEvidence.airportPence,
          other_pass_through_charges_pence: 0,
          currency_code: bookingEvidence.currency,
        },
        source: "booking",
        tipPence: 0,
        waitingBasis: "none",
        paymentSessionId: sessionId || null,
        logPrefix: "pc-integrity-recovery-booking-gap",
      });
      if (bookingGap.ok) snapshotsWritten += 1;
    }
  }
  const { count: snapCount } = await supabase
    .from("payment_payable_snapshots")
    .select("id", { count: "exact", head: true })
    .eq("trip_id", tripId);
  if ((snapCount ?? 0) === 0) {
    const snap = await writePayableSnapshotOrLog(supabase, {
      tripId,
      trip: tripSnapRow,
      source: "recovery",
      tipPence: Math.max(
        0,
        Math.round(Number(trip.tip_pence ?? trip.tip_amount_pence) || 0),
      ),
      waitingBasis: "columns",
      paymentSessionId: sessionId || null,
      logPrefix: "pc-integrity-recovery",
    });
    if (snap.ok) snapshotsWritten += 1;
  }

  // ── INCREMENT ops: reconcile from confirmed PSA rows only ─────────────────
  let incrementOpsReconciled = 0;
  if (sessionId) {
    const { data: session } = await supabase
      .from("payment_sessions")
      .select("id, provider_order_id, captured_amount_pence")
      .eq("id", sessionId)
      .maybeSingle();
    const orderId = String(session?.provider_order_id ?? "").trim();
    if (orderId) {
      const { data: psaRows } = await supabase
        .from("payment_session_authorisations")
        .select(
          "status, requested_target_total_pence, provider_confirmed_total_pence",
        )
        .eq("payment_session_id", sessionId)
        .eq("provider_order_id", orderId);
      for (const row of psaRows ?? []) {
        if (!isConfirmedIncrementRowStatus(row.status)) continue;
        const target = Math.round(Number(row.requested_target_total_pence) || 0);
        const confirmed = Math.round(
          Number(row.provider_confirmed_total_pence) || target,
        );
        if (target <= 0 || confirmed < target) continue;
        const r = await reconcileIncrementOperationsToCoverConfirmed(supabase, {
          tripId,
          paymentSessionId: sessionId,
          providerOrderId: orderId,
          targetAmountPence: target,
          confirmedAmountPence: confirmed,
          reason: "pc_integrity_recovery_psa",
        });
        incrementOpsReconciled += r.updated;
      }
    }
  }

  // ── Coverage stamp ────────────────────────────────────────────────────────
  let coverageStamped = false;
  const coverage = String(trip.payment_coverage_status ?? "").toLowerCase();
  if (capturedPence > 0 && coverage !== "captured" && coverage !== "partial") {
    const projection = buildTripPaymentProjectionAfterCapture({
      canonicalPayablePence: Math.max(
        capturedPence,
        Math.round(Number(trip.final_customer_fare_pence) || 0),
        Math.round(Number(trip.gross_fare_pence) || 0),
      ),
      totalCapturedPence: capturedPence,
      paymentProvider: "revolut",
    });
    const { error } = await supabase.from("trips").update({
      payment_coverage_status: projection.payment_coverage_status,
      outstanding_balance_pence: projection.outstanding_balance_pence,
      updated_at: new Date().toISOString(),
    }).eq("id", tripId);
    coverageStamped = !error;
  }

  // ── Abandoned modifications ───────────────────────────────────────────────
  const tcr = await terminalizeAbandonedTripChangeRequests(supabase, {
    tripId,
    reason: "abandoned_unapplied_at_trip_completion",
  });

  return {
    trip_id: tripId,
    trip_code: empty.trip_code,
    snapshots_written: snapshotsWritten,
    increment_ops_reconciled: incrementOpsReconciled,
    coverage_stamped: coverageStamped,
    tcr_terminalized: tcr.terminalized,
  };
}

/**
 * Bounded sweep: completed+captured PC trips with integrity gaps.
 * Never triggers customer capture.
 */
export async function sweepPlatformCollectedFinancialIntegrity(
  supabase: SupabaseClient,
  args?: { limit?: number },
): Promise<{ scanned: number; results: IntegrityRecoveryTripResult[] }> {
  const limit = Math.min(40, Math.max(1, Number(args?.limit ?? 15)));
  const { data: trips } = await supabase
    .from("trips")
    .select("id")
    .eq("status", "completed")
    .eq("payment_status", "captured")
    .eq("financial_model", "PLATFORM_COLLECTED")
    .order("completed_at", { ascending: false })
    .limit(limit * 3);

  const results: IntegrityRecoveryTripResult[] = [];
  let scanned = 0;
  for (const t of trips ?? []) {
    if (results.length >= limit) break;
    scanned += 1;
    const tripId = String(t.id);
    // Prefer trips missing snapshots or with stale coverage / pending TCR.
    const { count: snaps } = await supabase
      .from("payment_payable_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", tripId);
    const { count: bookingSnaps } = await supabase
      .from("payment_payable_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", tripId)
      .eq("source", "booking");
    const { data: tripRow } = await supabase
      .from("trips")
      .select("payment_coverage_status")
      .eq("id", tripId)
      .maybeSingle();
    const { count: pendingTcr } = await supabase
      .from("trip_change_requests")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", tripId)
      .in("status", ["payment_pending", "payment_required"]);
    const { count: unknownOps } = await supabase
      .from("payment_financial_operations")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", tripId)
      .eq("op_type", "INCREMENT")
      .in("state", ["INCREMENT_UNKNOWN", "INCREMENT_PENDING", "INCREMENT_REQUESTED"]);

    const needs =
      (snaps ?? 0) === 0
      || (bookingSnaps ?? 0) === 0
      || String(tripRow?.payment_coverage_status ?? "").toLowerCase() ===
        "authorization_insufficient"
      || (pendingTcr ?? 0) > 0
      || (unknownOps ?? 0) > 0;
    if (!needs) continue;

    results.push(
      await recoverPlatformCollectedTripFinancialIntegrity(supabase, { tripId }),
    );
  }
  return { scanned, results };
}
