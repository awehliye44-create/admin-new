/**
 * FR card reconciliation identity SSOT (display/classification only).
 *
 * Two clear attribution concepts:
 * - Cash / recovery-session: frozen capture composition (fare + tip + receivable)
 *   vs provider capture. Receivable component is NOT own-trip fare revenue.
 * - Economic / source-trip: original capture + provider-proven settled recovery
 *   allocation vs fare obligations (driver + commission + tip + airport).
 *
 * MK-003 recovery session: 740 − 704 − 36 = 0 (composition residual).
 * MK-012 source: 549 + 30 − 492 − 87 = 0.
 * MK-017 source: 500 + 6 − 430 − 76 = 0.
 *
 * Never rewrite original capture. Never double-count receivable across periods.
 * Never zero a residual merely because a status label says "resolved".
 * No money mutation — classification only.
 */

import { excludeTripFromPlatformCollectedFinance } from "./commissionWalletSSOT.ts";
import {
  applyRefundToTripAmounts,
  type PaymentSessionMoneyByTrip,
  type TripSSOTRow,
} from "./financialReconciliationSSOT.ts";
import {
  evaluateFrCaptureCompositionIdentityClosed,
  sumOpenReservedReceivableOutstandingPence,
  type SourceTripReceivableRecoveryRow,
} from "./frCaptureCompositionIdentitySSOT.ts";

function nonNeg(n: unknown): number {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function asNonNeg(n: unknown): number {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Provider-proven settled recovery applied to a source trip.
 * SETTLED/WAIVED → full original_amount.
 * OPEN/RESERVED with partial paydown → max(0, original − outstanding).
 * Fully open (outstanding === original) → 0.
 */
export function sumProviderProvenSettledReceivableAllocationPence(
  rows: ReadonlyArray<SourceTripReceivableRecoveryRow>,
  sourceTripId: string,
): number {
  const id = String(sourceTripId ?? "").trim();
  if (!id) return 0;
  let sum = 0;
  for (const r of rows) {
    if (String(r.source_trip_id) !== id) continue;
    const st = String(r.status ?? "").toUpperCase();
    const original = asNonNeg(r.original_amount_pence);
    const outstanding = asNonNeg(r.outstanding_amount_pence);
    if (st === "SETTLED" || st === "WAIVED") {
      sum += original;
      continue;
    }
    if (st === "OPEN" || st === "RESERVED") {
      // Partial: only the already-settled portion is provider-proven here.
      sum += Math.max(0, original - outstanding);
    }
  }
  return sum;
}

export type FrCardTripIdentityResidual = {
  trip_id: string;
  kind: "recovery_session" | "source_trip" | "standard";
  residual_pence: number | null;
  fail_closed: boolean;
  fail_reason: string | null;
  /** Capture leg used against fare liabilities (excludes receivable on recovery sessions). */
  fare_leg_capture_pence: number;
  settled_receivable_allocation_pence: number;
  composition_residual_pence: number | null;
  open_receivable_outstanding_pence: number;
};

export type FrCardTripIdentityInput = {
  id?: string | null;
  commission_pence?: number | null;
  driver_net_pence?: number | null;
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
  airport_charge_pence?: number | null;
  refund_amount_pence?: number | null;
  payment_method?: string | null;
  financial_model?: string | null;
};

/**
 * Per-trip card identity residual for Overview reconciliation.
 *
 * Recovery session (frozen composition with receivable > 0):
 *   composition residual + (fare_leg + tip_comp − driver − commission − tip − airport)
 *   → never compares full provider capture to own-trip fare liabilities alone.
 *
 * Source / standard trip:
 *   (net_capture + settled_allocation) − (driver + commission + tip + airport)
 */
export function computeTripCardReconciliationResidual(args: {
  trip: FrCardTripIdentityInput;
  captured_pence: number;
  session?: PaymentSessionMoneyByTrip | null;
  receivables?: ReadonlyArray<SourceTripReceivableRecoveryRow>;
  refund_pence?: number;
}): FrCardTripIdentityResidual {
  const tripId = String(args.trip.id ?? "").trim();
  const receivables = args.receivables ?? [];
  const openOutstanding = sumOpenReservedReceivableOutstandingPence(receivables, tripId);
  const settledAlloc = sumProviderProvenSettledReceivableAllocationPence(
    receivables,
    tripId,
  );

  const tip = nonNeg(
    args.trip.tip_pence ?? args.trip.tip_amount_pence ?? 0,
  );
  const airport = nonNeg(args.trip.airport_charge_pence);
  const commissionRaw = asNonNeg(args.trip.commission_pence);
  const driverRaw = asNonNeg(args.trip.driver_net_pence);
  const capturedRaw = asNonNeg(args.captured_pence);
  const refund = asNonNeg(
    args.refund_pence ?? args.trip.refund_amount_pence ?? 0,
  );
  const adjusted = applyRefundToTripAmounts({
    capturedPence: capturedRaw,
    refundPence: refund,
    commissionPence: commissionRaw,
    driverNetPence: driverRaw,
  });
  const netCapture = adjusted.net_captured_pence;
  const commission = adjusted.commission_pence;
  const driver = adjusted.driver_net_pence;

  const composition = evaluateFrCaptureCompositionIdentityClosed({
    session: args.session
      ? {
        trip_fare_component_pence: args.session.trip_fare_component_pence,
        tip_component_pence: args.session.tip_component_pence,
        receivable_component_pence: args.session.receivable_component_pence,
        buffer_pence: args.session.buffer_pence,
        provider_capture_target_pence: args.session.provider_capture_target_pence,
        metadata: args.session.metadata,
        captured_amount_pence: args.session.captured_amount_pence,
        purpose: args.session.purpose ?? null,
      }
      : null,
    actual_captured_pence: netCapture,
  });

  if (composition.kind === "fail_closed") {
    return {
      trip_id: tripId,
      kind: "recovery_session",
      residual_pence: null,
      fail_closed: true,
      fail_reason: composition.reason,
      fare_leg_capture_pence: 0,
      settled_receivable_allocation_pence: settledAlloc,
      composition_residual_pence: null,
      open_receivable_outstanding_pence: openOutstanding,
    };
  }

  if (
    composition.kind === "ok"
    && composition.identity.receivable_component_pence > 0
  ) {
    const identity = composition.identity;
    const compositionResidual = identity.capture_variance_pence;
    const fareLeg = identity.trip_fare_component_pence;
    const tipComp = identity.tip_component_pence;
    // Own-trip fare liabilities vs fare (+ tip) components only — receivable excluded.
    const fareLegResidual = (fareLeg + tipComp) - (driver + commission + tip + airport);
    return {
      trip_id: tripId,
      kind: "recovery_session",
      residual_pence: compositionResidual + fareLegResidual,
      fail_closed: false,
      fail_reason: null,
      fare_leg_capture_pence: fareLeg,
      settled_receivable_allocation_pence: 0, // economic credit lives on source trips
      composition_residual_pence: compositionResidual,
      open_receivable_outstanding_pence: openOutstanding,
    };
  }

  // Source / standard: original capture unchanged; add settled recovery allocation only.
  const lhs = netCapture + settledAlloc;
  const rhs = driver + commission + tip + airport;
  return {
    trip_id: tripId,
    kind: settledAlloc > 0 ? "source_trip" : "standard",
    residual_pence: lhs - rhs,
    fail_closed: false,
    fail_reason: null,
    fare_leg_capture_pence: netCapture,
    settled_receivable_allocation_pence: settledAlloc,
    composition_residual_pence: null,
    open_receivable_outstanding_pence: openOutstanding,
  };
}

export type FrCardIdentityAggregate = {
  variance_pence: number | null;
  balanced: boolean;
  status: "BALANCED" | "RECONCILIATION_MISMATCH";
  fail_closed: boolean;
  fail_reasons: string[];
  trip_count: number;
  /** Identity LHS total (fare-leg + settled alloc; excludes recovery receivable cash). */
  identity_lhs_pence: number;
  identity_rhs_pence: number;
  trip_residuals: FrCardTripIdentityResidual[];
};

/**
 * Aggregate Overview card identity residual across capture-confirmed trips.
 * Fail-closed if any required composition evidence is missing.
 */
export function computeCardReconciliationIdentityAggregate(args: {
  trips: TripSSOTRow[];
  paymentByTrip: Map<string, number>;
  sessionByTrip?: Map<string, PaymentSessionMoneyByTrip>;
  receivables?: ReadonlyArray<SourceTripReceivableRecoveryRow>;
  refundByTrip?: Map<string, number>;
}): FrCardIdentityAggregate {
  const residuals: FrCardTripIdentityResidual[] = [];
  let variance = 0;
  let lhs = 0;
  let rhs = 0;
  const failReasons: string[] = [];
  let failClosed = false;

  for (const trip of args.trips) {
    if (excludeTripFromPlatformCollectedFinance(trip)) continue;
    const tripId = trip.id ?? "";
    if (!tripId) continue;
    const captured = args.paymentByTrip.get(tripId) ?? 0;
    if (captured <= 0) continue; // pending / unconfirmed — not in reconciled identity

    const residual = computeTripCardReconciliationResidual({
      trip,
      captured_pence: captured,
      session: args.sessionByTrip?.get(tripId) ?? null,
      receivables: args.receivables,
      refund_pence: args.refundByTrip?.get(tripId),
    });
    residuals.push(residual);

    if (residual.fail_closed || residual.residual_pence == null) {
      failClosed = true;
      if (residual.fail_reason) failReasons.push(`${tripId}:${residual.fail_reason}`);
      continue;
    }

    variance += residual.residual_pence;
    // Reconstruct LHS/RHS for reporting (tips/airport already inside residual).
    const tip = nonNeg(trip.tip_pence ?? trip.tip_amount_pence ?? 0);
    const airport = nonNeg(trip.airport_charge_pence);
    const adjusted = applyRefundToTripAmounts({
      capturedPence: captured,
      refundPence: args.refundByTrip?.get(tripId) ?? asNonNeg(trip.refund_amount_pence),
      commissionPence: asNonNeg(trip.commission_pence),
      driverNetPence: asNonNeg(trip.driver_net_pence),
    });
    if (residual.kind === "recovery_session") {
      lhs += residual.fare_leg_capture_pence
        + nonNeg(
          args.sessionByTrip?.get(tripId)?.tip_component_pence
            ?? trip.tip_pence
            ?? trip.tip_amount_pence,
        );
      // Composition residual already folded into residual_pence; report fare-leg LHS.
    } else {
      lhs += residual.fare_leg_capture_pence + residual.settled_receivable_allocation_pence;
    }
    rhs += adjusted.driver_net_pence + adjusted.commission_pence + tip + airport;
  }

  if (failClosed) {
    return {
      variance_pence: null,
      balanced: false,
      status: "RECONCILIATION_MISMATCH",
      fail_closed: true,
      fail_reasons: failReasons,
      trip_count: residuals.length,
      identity_lhs_pence: lhs,
      identity_rhs_pence: rhs,
      trip_residuals: residuals,
    };
  }

  const balanced = variance === 0;
  return {
    variance_pence: variance,
    balanced,
    status: balanced ? "BALANCED" : "RECONCILIATION_MISMATCH",
    fail_closed: false,
    fail_reasons: [],
    trip_count: residuals.length,
    identity_lhs_pence: lhs,
    identity_rhs_pence: rhs,
    trip_residuals: residuals,
  };
}

/**
 * Current outstanding from receivable ledger only (OPEN/RESERVED).
 * SETTLED/WAIVED → 0. Never final_fare − original_capture.
 */
export function resolveCurrentOutstandingFromReceivables(args: {
  receivablesLedgerAvailable: boolean;
  receivables: ReadonlyArray<SourceTripReceivableRecoveryRow>;
  sourceTripId: string;
}): { outstanding_pence: number; source: "receivable_ledger" | "ledger_unavailable" } {
  if (!args.receivablesLedgerAvailable) {
    return { outstanding_pence: 0, source: "ledger_unavailable" };
  }
  return {
    outstanding_pence: sumOpenReservedReceivableOutstandingPence(
      args.receivables,
      args.sourceTripId,
    ),
    source: "receivable_ledger",
  };
}
