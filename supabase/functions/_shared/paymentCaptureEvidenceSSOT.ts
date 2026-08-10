/**
 * Canonical capture evidence rules for Revolut/card/mobile-wallet payments.
 * captured_amount_pence = 0 is never valid terminal capture for a positive-fare ride.
 */

export type CaptureRepairClassification =
  | "CAPTURE_AMOUNT_MISSING"
  | "CAPTURE_ZERO_INVALID"
  | "CAPTURE_AMOUNT_MISMATCH"
  | "CAPTURE_COMPLETE";

export type CaptureEvidenceClassification =
  | CaptureRepairClassification
  | "CAPTURE_EVIDENCE_MISMATCH"
  | "PROVIDER_CAPTURE_PENDING";

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

export function classifyCaptureRepair(args: {
  providerState?: string | null;
  providerCapturedAmountPence: number | null | undefined;
  localCapturedAmountPence: number | null | undefined;
  expectedCapturePence?: number | null | undefined;
}): CaptureRepairClassification {
  const providerState = String(args.providerState ?? "").toUpperCase();
  const providerCaptured =
    providerState === "CAPTURED"
    || providerState === "COMPLETED"
    || isValidConfirmedCapturePence(args.providerCapturedAmountPence);
  const providerAmt = confirmedPositiveCapturePence(args.providerCapturedAmountPence);
  const localAmt = confirmedPositiveCapturePence(args.localCapturedAmountPence);
  const localRaw = args.localCapturedAmountPence == null
    ? null
    : Number(args.localCapturedAmountPence);

  if (providerAmt != null && localAmt != null && providerAmt === localAmt) {
    return "CAPTURE_COMPLETE";
  }

  if (providerAmt != null && localAmt != null && providerAmt !== localAmt) {
    return "CAPTURE_AMOUNT_MISMATCH";
  }

  if (providerCaptured && (localRaw == null || !Number.isFinite(localRaw))) {
    return "CAPTURE_AMOUNT_MISSING";
  }

  if (providerCaptured && localRaw != null && localRaw <= 0) {
    return "CAPTURE_ZERO_INVALID";
  }

  if (providerAmt != null && localAmt == null) {
    return localRaw != null && localRaw <= 0
      ? "CAPTURE_ZERO_INVALID"
      : "CAPTURE_AMOUNT_MISSING";
  }

  if (localAmt != null) return "CAPTURE_COMPLETE";
  return "CAPTURE_AMOUNT_MISSING";
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

/**
 * CAPTURED_COMPLETE requires provider terminal capture + local amount > 0
 * (+ optional fare coverage / explicit variance classification).
 */
export function isCapturedComplete(args: {
  providerState?: string | null;
  capturedAmountPence: number | null | undefined;
  capturedAt?: string | null;
  expectedCapturePence?: number | null | undefined;
  varianceExplicitlyClassified?: boolean;
}): boolean {
  const providerOk =
    String(args.providerState ?? "").toUpperCase() === "CAPTURED"
    || String(args.providerState ?? "").toUpperCase() === "COMPLETED"
    || Boolean(args.capturedAt);
  if (!providerOk) return false;
  if (!isValidConfirmedCapturePence(args.capturedAmountPence)) return false;
  const expected = confirmedPositiveCapturePence(args.expectedCapturePence);
  if (expected != null && Math.round(Number(args.capturedAmountPence)) !== expected) {
    return args.varianceExplicitlyClassified === true;
  }
  return true;
}

/** Historical fallback: provider captured/completed but local null/zero. */
export function isCaptureEvidenceMismatch(args: {
  providerState?: string | null;
  localCapturedAmountPence: number | null | undefined;
  expectedCapturePence?: number | null | undefined;
}): boolean {
  const state = String(args.providerState ?? "").toUpperCase();
  if (state !== "CAPTURED" && state !== "COMPLETED") return false;
  const expected = args.expectedCapturePence == null
    ? null
    : Number(args.expectedCapturePence);
  const positiveFare = expected == null || expected > 0;
  if (!positiveFare) return false;
  return !isValidConfirmedCapturePence(args.localCapturedAmountPence);
}

/**
 * Digital wallet earning payout eligibility — requires confirmed capture > 0
 * covering required fare (unless explicit partial settlement approved).
 */
export function isDigitalTripEarningPayoutEligible(args: {
  paymentMethod?: string | null;
  tripCompleted?: boolean;
  providerCaptureConfirmed?: boolean;
  capturedAmountPence?: number | null;
  requiredCustomerFarePence?: number | null;
  captureMismatchUnresolved?: boolean;
  partialSettlementApproved?: boolean;
}): boolean {
  const method = String(args.paymentMethod ?? "").trim().toLowerCase();
  const digital = method === "card"
    || method === "apple_pay"
    || method === "google_pay"
    || method === "revolut";
  if (!digital) return true;
  if (args.tripCompleted === false) return false;
  if (args.captureMismatchUnresolved) return false;
  if (args.providerCaptureConfirmed === false) return false;
  if (!isValidConfirmedCapturePence(args.capturedAmountPence)) return false;
  const required = confirmedPositiveCapturePence(args.requiredCustomerFarePence);
  if (required != null && Number(args.capturedAmountPence) < required) {
    return args.partialSettlementApproved === true;
  }
  return true;
}

/** Provider fee reduces ONECAB net commission only — never driver net. */
export function computeOnecabNetCommissionAfterProviderFee(args: {
  grossCommissionPence: number | null | undefined;
  providerFeePence: number | null | undefined;
}): {
  gross_commission_pence: number;
  provider_fee_pence: number;
  net_commission_pence: number;
} {
  const gross = Math.max(0, Math.round(Number(args.grossCommissionPence ?? 0)));
  const fee = Math.max(0, Math.round(Number(args.providerFeePence ?? 0)));
  return {
    gross_commission_pence: gross,
    provider_fee_pence: fee,
    net_commission_pence: Math.max(0, gross - fee),
  };
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

/**
 * Webhook event identity — never use provider_order_id alone.
 * Prefer provider event.id; otherwise compose event+order+stable discriminator.
 */
export function resolveRevolutWebhookEventIdentity(args: {
  eventId?: string | null;
  eventName?: string | null;
  orderId?: string | null;
  payoutId?: string | null;
  merchantOrderExtRef?: string | null;
  rawBodyFingerprint?: string | null;
}): { event_id: string; order_id: string | null } {
  const orderId = typeof args.orderId === "string" && args.orderId.trim()
    ? args.orderId.trim()
    : null;
  const explicit = typeof args.eventId === "string" && args.eventId.trim()
    ? args.eventId.trim()
    : null;

  if (explicit && (!orderId || explicit !== orderId)) {
    return { event_id: explicit, order_id: orderId };
  }

  const eventName = String(args.eventName ?? "unknown").trim() || "unknown";
  const payoutId = typeof args.payoutId === "string" && args.payoutId.trim()
    ? args.payoutId.trim()
    : null;
  const ext = typeof args.merchantOrderExtRef === "string" && args.merchantOrderExtRef.trim()
    ? args.merchantOrderExtRef.trim()
    : null;
  const fp = typeof args.rawBodyFingerprint === "string" && args.rawBodyFingerprint.trim()
    ? args.rawBodyFingerprint.trim().slice(0, 64)
    : null;

  const parts = [eventName, orderId ?? payoutId ?? ext ?? "no_order", fp ?? "no_fp"];
  return { event_id: parts.join(":"), order_id: orderId };
}
