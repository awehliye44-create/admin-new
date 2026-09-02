/**
 * Payment Sessions economic capture timestamp — never restamp on provider refresh.
 *
 * captured_at is the first confirmed capture time. Provider re-verification uses
 * provider_state_verified_at (or refreshed_at metadata), not captured_at.
 */

export const CAPTURED_AT_RESTAMP_SUSPECT = "CAPTURED_AT_RESTAMP_SUSPECT" as const;

export type PaymentSessionCaptureAdvanceExtrasInput = {
  storedCapturedAt?: string | null;
  storedCapturedAmountPence?: number | null;
  incomingCapturedAmountPence?: number | null;
  nowIso: string;
};

function roundPence(value: unknown): number | null {
  if (value == null) return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : null;
}

/** True when captured_at looks like an admin refresh restamp, not economic capture. */
export function isCapturedAtRestampSuspect(args: {
  captured_at?: string | null;
  trip_completed_at?: string | null;
  ledger_created_at?: string | null;
  restamp_threshold_hours?: number;
}): boolean {
  const capturedMs = args.captured_at ? Date.parse(String(args.captured_at)) : NaN;
  const completedMs = args.trip_completed_at ? Date.parse(String(args.trip_completed_at)) : NaN;
  const ledgerMs = args.ledger_created_at ? Date.parse(String(args.ledger_created_at)) : NaN;
  if (!Number.isFinite(capturedMs) || !Number.isFinite(completedMs) || !Number.isFinite(ledgerMs)) {
    return false;
  }
  const thresholdMs = Math.max(1, args.restamp_threshold_hours ?? 48) * 3_600_000;
  return capturedMs > completedMs + thresholdMs && ledgerMs < capturedMs;
}

/**
 * Build status ADVANCE extras for COMPLETED/CAPTURED provider evidence.
 * Preserves existing captured_at; only stamps on first confirmed capture.
 */
export function resolvePaymentSessionCaptureAdvanceExtras(
  input: PaymentSessionCaptureAdvanceExtrasInput,
): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  const incoming = roundPence(input.incomingCapturedAmountPence);
  const storedAmount = roundPence(input.storedCapturedAmountPence);
  const storedAt = input.storedCapturedAt ? String(input.storedCapturedAt).trim() : "";

  if (incoming == null || incoming <= 0) {
    return extras;
  }

  const firstCapture = storedAmount == null || storedAmount <= 0;

  if (firstCapture) {
    extras.captured_amount_pence = incoming;
    extras.captured_at = input.nowIso;
    return extras;
  }

  // Amount materially missing only when stored was absent — already handled above.
  // Reconcile amount when provider reports a positive capture and stored differs,
  // but never restamp captured_at.
  if (storedAmount !== incoming) {
    extras.captured_amount_pence = incoming;
  }

  if (!storedAt && !("captured_at" in extras)) {
    // Legacy row: captured amount present but timestamp missing — stamp once.
    extras.captured_at = input.nowIso;
  }

  return extras;
}

/**
 * Earliest credible economic settlement timestamp for payout clearing.
 * Ignores forward-restamped captured_at when ledger was credited earlier.
 */
export function resolveStablePayoutClearingOriginMs(args: {
  captured_at?: string | null;
  trip_completed_at?: string | null;
  earning_credited_at?: string | null;
  capture_time?: string | null;
  first_captured_at?: string | null;
  restamp_threshold_hours?: number;
}): number | null {
  const restampSuspect = isCapturedAtRestampSuspect({
    captured_at: args.captured_at,
    trip_completed_at: args.trip_completed_at,
    ledger_created_at: args.earning_credited_at,
    restamp_threshold_hours: args.restamp_threshold_hours,
  });

  const candidates: number[] = [];
  const push = (value?: string | null) => {
    if (!value) return;
    const ms = Date.parse(String(value));
    if (Number.isFinite(ms)) candidates.push(ms);
  };

  push(args.first_captured_at);
  if (!restampSuspect) push(args.captured_at);
  push(args.capture_time);
  push(args.earning_credited_at);
  push(args.trip_completed_at);

  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}
