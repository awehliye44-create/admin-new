/**
 * Canonical capture evidence rules for Revolut/card/mobile-wallet payments.
 * captured_amount_pence = 0 is never valid terminal capture for a positive-fare ride.
 */

export type CaptureRepairClassification =
  | "CAPTURE_AMOUNT_MISSING"
  | "CAPTURE_ZERO_INVALID"
  | "CAPTURE_AMOUNT_MISMATCH"
  | "CAPTURE_COMPLETE";

/** True only when amount is a confirmed positive capture (pence). */
export function isValidConfirmedCapturePence(
  amount: number | null | undefined,
): amount is number {
  if (amount == null) return false;
  const n = Number(amount);
  return Number.isFinite(n) && n > 0;
}

/** Normalise to positive integer pence or null (never returns 0). */
export function confirmedPositiveCapturePence(
  amount: number | null | undefined,
): number | null {
  if (!isValidConfirmedCapturePence(amount)) return null;
  return Math.round(Number(amount));
}

/**
 * Prefer provider-confirmed capture over invalid local evidence.
 * Local 0 / null never blocks a positive provider amount.
 */
export function resolveCaptureAmountToPersist(args: {
  localCapturedAmountPence: number | null | undefined;
  providerCapturedAmountPence: number | null | undefined;
}): {
  amount_pence: number | null;
  used_provider: boolean;
  local_was_invalid: boolean;
} {
  const provider = confirmedPositiveCapturePence(args.providerCapturedAmountPence);
  const localValid = isValidConfirmedCapturePence(args.localCapturedAmountPence);
  const local = localValid ? Math.round(Number(args.localCapturedAmountPence)) : null;
  const localWasInvalid =
    args.localCapturedAmountPence != null
    && Number(args.localCapturedAmountPence) <= 0;

  if (provider != null) {
    if (local != null && local === provider) {
      return { amount_pence: local, used_provider: false, local_was_invalid: false };
    }
    if (local == null || localWasInvalid) {
      return { amount_pence: provider, used_provider: true, local_was_invalid: localWasInvalid };
    }
    // Local positive but differs — caller must treat as mismatch; still return provider for controlled repair.
    return { amount_pence: provider, used_provider: true, local_was_invalid: false };
  }

  if (local != null) {
    return { amount_pence: local, used_provider: false, local_was_invalid: false };
  }

  return {
    amount_pence: null,
    used_provider: false,
    local_was_invalid: localWasInvalid,
  };
}

/** Repair when provider confirms > 0 and local is missing, zero, or mismatched. */
export function shouldRepairCaptureEvidence(args: {
  providerCapturedAmountPence: number | null | undefined;
  localCapturedAmountPence: number | null | undefined;
}): boolean {
  const provider = confirmedPositiveCapturePence(args.providerCapturedAmountPence);
  if (provider == null) return false;
  const local = confirmedPositiveCapturePence(args.localCapturedAmountPence);
  if (local == null) return true;
  return local !== provider;
}

/** Extract Revolut acquiring fee (pence) from sanitised order payload. */
export function extractProviderFeePence(
  providerPayload: Record<string, unknown> | null | undefined,
): number | null {
  if (!providerPayload) return null;
  const payments = Array.isArray(providerPayload.payments) ? providerPayload.payments : [];
  for (const p of payments) {
    if (!p || typeof p !== "object") continue;
    const fees = (p as { fees?: unknown }).fees;
    if (!Array.isArray(fees)) continue;
    for (const f of fees) {
      if (!f || typeof f !== "object") continue;
      const fee = f as { type?: unknown; amount?: unknown };
      const type = String(fee.type ?? "").toUpperCase();
      if (type && type !== "ACQUIRING") continue;
      const raw = fee.amount;
      if (raw != null && typeof raw === "object" && "value" in (raw as object)) {
        const n = Number((raw as { value?: unknown }).value);
        if (Number.isFinite(n) && n > 0) return Math.round(n);
      }
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
    }
  }
  return null;
}

