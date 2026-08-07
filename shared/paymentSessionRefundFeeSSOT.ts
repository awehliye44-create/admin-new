/**
 * Payment Sessions — refund child SSOT + provider fee status (Slice 3).
 * Never invent refund or fee amounts. Never use webhook event id as provider_refund_id.
 */

export const FEE_STATUS = {
  ACTUAL: "ACTUAL",
  ESTIMATED: "ESTIMATED",
  PENDING: "PENDING",
  UNAVAILABLE: "UNAVAILABLE",
} as const;

export type FeeStatus = typeof FEE_STATUS[keyof typeof FEE_STATUS];

/**
 * Extract provider refund id from Revolut (or similar) event/order payload.
 * Never returns the webhook event id.
 */
export function extractProviderRefundId(args: {
  eventId?: string | null;
  eventData?: Record<string, unknown> | null;
  providerRefundIdHint?: string | null;
}): { provider_refund_id: string | null; webhook_event_id: string | null } {
  const eventId = typeof args.eventId === "string" && args.eventId.trim()
    ? args.eventId.trim()
    : null;
  const hint = typeof args.providerRefundIdHint === "string" && args.providerRefundIdHint.trim()
    ? args.providerRefundIdHint.trim()
    : null;

  if (hint && hint !== eventId) {
    return { provider_refund_id: hint, webhook_event_id: eventId };
  }

  const data = args.eventData && typeof args.eventData === "object"
    ? args.eventData
    : null;
  if (!data) {
    return { provider_refund_id: null, webhook_event_id: eventId };
  }

  const candidates: unknown[] = [
    data.refund_id,
    data.provider_refund_id,
  ];
  const refundObj = data.refund;
  if (refundObj && typeof refundObj === "object") {
    candidates.push((refundObj as { id?: unknown }).id);
  }
  const refunds = data.refunds;
  if (Array.isArray(refunds)) {
    for (const r of refunds) {
      if (r && typeof r === "object") {
        candidates.push((r as { id?: unknown }).id);
      }
    }
  }

  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const id = c.trim();
    if (!id) continue;
    // Never treat webhook event id as refund identity.
    if (eventId && id === eventId) continue;
    return { provider_refund_id: id, webhook_event_id: eventId };
  }

  return { provider_refund_id: null, webhook_event_id: eventId };
}

/** Parent refunded total from confirmed child rows — NULL when none (never invent £0). */
export function sumRefundChildrenPence(
  rows: Array<{ amount_pence?: number | null; status?: string | null }>,
): number | null {
  let sum = 0;
  let any = false;
  for (const r of rows) {
    const status = String(r.status ?? "confirmed").toLowerCase();
    if (status === "failed" || status === "cancelled") continue;
    const amt = Number(r.amount_pence);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    sum += Math.round(amt);
    any = true;
  }
  return any ? sum : null;
}

export function classifyFeeStatus(args: {
  providerFeePence: number | null | undefined;
  retrieveSucceeded?: boolean;
}): { fee_status: FeeStatus; provider_processing_fee_pence: number | null } {
  const fee = args.providerFeePence;
  if (fee != null && Number.isFinite(Number(fee)) && Number(fee) > 0) {
    return {
      fee_status: FEE_STATUS.ACTUAL,
      provider_processing_fee_pence: Math.round(Number(fee)),
    };
  }
  if (args.retrieveSucceeded === false) {
    return {
      fee_status: FEE_STATUS.UNAVAILABLE,
      provider_processing_fee_pence: null,
    };
  }
  return {
    fee_status: FEE_STATUS.PENDING,
    provider_processing_fee_pence: null,
  };
}

/** ONECAB net after fee — fee never touches driver net. */
export function onecabNetAfterProviderFee(args: {
  grossCommissionPence: number | null | undefined;
  providerFeePence: number | null | undefined;
}): number | null {
  if (args.grossCommissionPence == null || !Number.isFinite(Number(args.grossCommissionPence))) {
    return null;
  }
  if (args.providerFeePence == null || !Number.isFinite(Number(args.providerFeePence))) {
    return null;
  }
  const gross = Math.max(0, Math.round(Number(args.grossCommissionPence)));
  const fee = Math.max(0, Math.round(Number(args.providerFeePence)));
  return Math.max(0, gross - fee);
}

export function buildRefundIdempotencyKey(args: {
  paymentProvider: string;
  providerRefundId: string;
}): string {
  return `ps_refund:${args.paymentProvider}:${args.providerRefundId}`;
}

/** Provider-confirmed refund amount only — never use cancelled/released fields. */
export function extractConfirmedRefundAmountPence(
  providerPayload: Record<string, unknown> | null | undefined,
): number | null {
  if (!providerPayload) return null;
  const asPence = (raw: unknown): number | null => {
    if (raw == null) return null;
    if (typeof raw === "object" && raw !== null && "value" in (raw as object)) {
      const n = Number((raw as { value?: unknown }).value);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
      return null;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
    return null;
  };
  for (const key of ["refunded_amount", "amount_refunded", "refund_amount"]) {
    const n = asPence(providerPayload[key]);
    if (n != null) return n;
  }
  const refunds = providerPayload.refunds;
  if (Array.isArray(refunds)) {
    let sum = 0;
    let any = false;
    for (const r of refunds) {
      if (!r || typeof r !== "object") continue;
      const n = asPence((r as { amount?: unknown }).amount);
      if (n == null) continue;
      sum += n;
      any = true;
    }
    if (any) return sum;
  }
  return null;
}

/**
 * REFUNDED with refund money evidence is a refund lifecycle, not a hold release.
 * Without refund amount evidence, treat as non-refund terminal (legacy release path).
 */
export function isRefundTerminalNotRelease(args: {
  providerCanonical: string | null | undefined;
  refundAmountPence: number | null | undefined;
}): boolean {
  const state = String(args.providerCanonical ?? "").toUpperCase();
  if (state !== "REFUNDED") return false;
  return args.refundAmountPence != null
    && Number.isFinite(Number(args.refundAmountPence))
    && Number(args.refundAmountPence) > 0;
}
