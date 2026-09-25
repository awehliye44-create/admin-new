/**
 * FR capture-composition identity SSOT (display/classification only).
 *
 * When a payment session carries typed capture composition, expected provider
 * capture is the sum of planned components — never trip fare alone:
 *   trip_fare + tip + receivable (+ any explicit planned capture component)
 *
 * MK-260925-003: 704 + 0 + 36 = 740 → variance 0 → settlement identity balanced.
 *
 * Fold/buffer stay OFF: buffer is not part of capture target unless explicitly
 * persisted as a capture component (normally 0).
 *
 * No money mutation — classification only.
 */

import {
  readCaptureCompositionComponents,
  type CaptureCompositionComponents,
} from "./captureCompositionLocalApplySSOT.ts";

export const FR_RESOLVED_BY_RECEIVABLE_RECOVERY =
  "RESOLVED_BY_RECEIVABLE_RECOVERY" as const;

export type FrCaptureCompositionIdentity = {
  has_composition: boolean;
  trip_fare_component_pence: number;
  tip_component_pence: number;
  receivable_component_pence: number;
  buffer_component_pence: number;
  expected_provider_capture_pence: number;
  actual_provider_capture_pence: number;
  capture_variance_pence: number;
  settlement_identity_balanced: boolean;
};

function nonNeg(n: unknown): number {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function resolveExpectedProviderCaptureFromComposition(
  composition: CaptureCompositionComponents,
): number {
  const target = nonNeg(composition.provider_capture_target_pence);
  if (target > 0) return target;
  return (
    nonNeg(composition.trip_fare_component_pence)
    + nonNeg(composition.tip_component_pence)
    + nonNeg(composition.receivable_component_pence)
  );
}

/**
 * Prefer composition identity when receivable (or multi-component target)
 * is present. Returns null when composition is absent / fare-only.
 */
export function evaluateFrCaptureCompositionIdentity(args: {
  session: {
    trip_fare_component_pence?: number | null;
    tip_component_pence?: number | null;
    receivable_component_pence?: number | null;
    buffer_pence?: number | null;
    provider_capture_target_pence?: number | null;
    metadata?: Record<string, unknown> | null;
    captured_amount_pence?: number | null;
  } | null | undefined;
  actual_captured_pence?: number | null;
}): FrCaptureCompositionIdentity | null {
  const composition = readCaptureCompositionComponents(args.session);
  if (!composition) return null;

  const receivable = nonNeg(composition.receivable_component_pence);
  const tip = nonNeg(composition.tip_component_pence);
  const fare = nonNeg(composition.trip_fare_component_pence);
  const expected = resolveExpectedProviderCaptureFromComposition(composition);

  // Composition identity applies when recovery/multi-leg capture is present.
  if (receivable <= 0 && tip <= 0 && expected <= 0) return null;
  if (receivable <= 0 && expected === fare) {
    // Pure fare-only composition — leave legacy allocation identity alone.
    return null;
  }

  const actual = nonNeg(
    args.actual_captured_pence
      ?? args.session?.captured_amount_pence,
  );
  if (actual <= 0 || expected <= 0) return null;

  const variance = actual - expected;
  return {
    has_composition: true,
    trip_fare_component_pence: fare,
    tip_component_pence: tip,
    receivable_component_pence: receivable,
    buffer_component_pence: nonNeg(composition.preauth_buffer_component_pence),
    expected_provider_capture_pence: expected,
    actual_provider_capture_pence: actual,
    capture_variance_pence: variance,
    settlement_identity_balanced: variance === 0,
  };
}

export type SourceTripReceivableRecoveryRow = {
  source_trip_id: string;
  status: string;
  outstanding_amount_pence: number;
  original_amount_pence: number;
  reserved_payment_session_id?: string | null;
  settled_at?: string | null;
};

/** Current open outstanding for a source trip (OPEN/RESERVED only). */
export function sumOpenReservedReceivableOutstandingPence(
  rows: ReadonlyArray<SourceTripReceivableRecoveryRow>,
  sourceTripId: string,
): number {
  const id = String(sourceTripId ?? "").trim();
  if (!id) return 0;
  let sum = 0;
  for (const r of rows) {
    if (String(r.source_trip_id) !== id) continue;
    const st = String(r.status ?? "").toUpperCase();
    if (st !== "OPEN" && st !== "RESERVED") continue;
    sum += Math.max(0, Math.round(Number(r.outstanding_amount_pence) || 0));
  }
  return sum;
}

export type ReceivableRecoveryClassification = {
  resolved_by_receivable_recovery: boolean;
  status: typeof FR_RESOLVED_BY_RECEIVABLE_RECOVERY | null;
  settled_original_pence: number;
  open_outstanding_pence: number;
  recovery_payment_session_id: string | null;
};

/**
 * Historical shortfall on source trip may remain as immutable evidence, but when
 * all linked receivables are SETTLED/WAIVED with zero open outstanding, classify
 * as RESOLVED_BY_RECEIVABLE_RECOVERY and exclude from open issue totals.
 */
export function classifySourceTripReceivableRecovery(
  rows: ReadonlyArray<SourceTripReceivableRecoveryRow>,
  sourceTripId: string,
): ReceivableRecoveryClassification {
  const id = String(sourceTripId ?? "").trim();
  const open = sumOpenReservedReceivableOutstandingPence(rows, id);
  let settledOriginal = 0;
  let recoverySession: string | null = null;
  let hasSettled = false;
  for (const r of rows) {
    if (String(r.source_trip_id) !== id) continue;
    const st = String(r.status ?? "").toUpperCase();
    if (st === "SETTLED" || st === "WAIVED") {
      hasSettled = true;
      settledOriginal += Math.max(0, Math.round(Number(r.original_amount_pence) || 0));
      const sid = String(r.reserved_payment_session_id ?? "").trim();
      if (sid && !recoverySession) recoverySession = sid;
    }
  }
  const resolved = hasSettled && open === 0 && settledOriginal > 0;
  return {
    resolved_by_receivable_recovery: resolved,
    status: resolved ? FR_RESOLVED_BY_RECEIVABLE_RECOVERY : null,
    settled_original_pence: settledOriginal,
    open_outstanding_pence: open,
    recovery_payment_session_id: recoverySession,
  };
}
