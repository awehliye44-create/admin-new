/**
 * Bug #37 — immutable Google Pay payment-attempt context.
 *
 * One Wallet authorisation is bound to exactly one Revolut order + public
 * order token + payment session + amount/currency. A token minted for attempt
 * A must never be submitted against order B.
 *
 * Never store or log raw Google Pay payment tokens / cryptograms.
 */

export type GooglePayAttemptSnapshot = {
  generation: number;
  payment_session_id: string;
  provider_order_id: string;
  /** SHA-256 hex of Revolut order.token used as Google Pay gatewayMerchantId. */
  order_token_sha256: string;
  /** Last 8 chars of order.token — ops correlation only (public checkout token). */
  order_token_suffix: string;
  amount_pence: number;
  currency: string;
  created_at: string;
};

export type GooglePayAttemptBindInput = {
  paymentSessionId: string;
  providerOrderId: string;
  orderToken: string;
  amountPence: number;
  currency: string;
  generation?: number;
  createdAt?: string;
};

export type GooglePayAttemptVerifyInput = {
  snapshot: GooglePayAttemptSnapshot | null | undefined;
  paymentSessionId: string;
  providerOrderId: string;
  /** SHA-256 of the order token actually passed to Google Pay as gatewayMerchantId. */
  gatewayMerchantIdSha256: string | null | undefined;
  amountPence?: number | null;
  currency?: string | null;
};

export type GooglePayAttemptVerifyResult =
  | { ok: true; snapshot: GooglePayAttemptSnapshot }
  | {
      ok: false;
      code:
        | "GOOGLE_PAY_ATTEMPT_MISSING"
        | "GOOGLE_PAY_ATTEMPT_SESSION_MISMATCH"
        | "GOOGLE_PAY_ATTEMPT_ORDER_MISMATCH"
        | "GOOGLE_PAY_ATTEMPT_TOKEN_MISMATCH"
        | "GOOGLE_PAY_ATTEMPT_AMOUNT_MISMATCH"
        | "GOOGLE_PAY_ATTEMPT_CURRENCY_MISMATCH"
        | "GOOGLE_PAY_ATTEMPT_GATEWAY_SHA_MISSING";
      message: string;
    };

function trimStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function orderTokenSuffix(orderToken: string): string {
  const t = trimStr(orderToken);
  return t.length > 8 ? t.slice(-8) : t;
}

/** Web Crypto SHA-256 hex (Edge / Deno). */
export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function buildGooglePayAttemptSnapshot(
  input: GooglePayAttemptBindInput,
): Promise<GooglePayAttemptSnapshot> {
  const orderToken = trimStr(input.orderToken);
  const providerOrderId = trimStr(input.providerOrderId);
  const paymentSessionId = trimStr(input.paymentSessionId);
  if (!orderToken || !providerOrderId || !paymentSessionId) {
    throw new Error("google_pay_attempt_bind_incomplete");
  }
  if (orderToken === providerOrderId) {
    // Revolut order.id must never be used as gatewayMerchantId.
    throw new Error("google_pay_attempt_order_id_used_as_token");
  }
  const amount = Math.round(Number(input.amountPence));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("google_pay_attempt_amount_invalid");
  }
  const currency = trimStr(input.currency).toUpperCase() || "GBP";
  return {
    generation: Math.max(1, Math.round(Number(input.generation ?? 1)) || 1),
    payment_session_id: paymentSessionId,
    provider_order_id: providerOrderId,
    order_token_sha256: await sha256Hex(orderToken),
    order_token_suffix: orderTokenSuffix(orderToken),
    amount_pence: amount,
    currency,
    created_at: input.createdAt ?? new Date().toISOString(),
  };
}

export function readGooglePayAttemptSnapshot(
  metadata: Record<string, unknown> | null | undefined,
): GooglePayAttemptSnapshot | null {
  const raw = metadata?.google_pay_attempt;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const payment_session_id = trimStr(o.payment_session_id);
  const provider_order_id = trimStr(o.provider_order_id);
  const order_token_sha256 = trimStr(o.order_token_sha256).toLowerCase();
  const order_token_suffix = trimStr(o.order_token_suffix);
  const currency = trimStr(o.currency).toUpperCase();
  const amount_pence = Math.round(Number(o.amount_pence));
  const generation = Math.round(Number(o.generation));
  const created_at = trimStr(o.created_at);
  if (
    !payment_session_id ||
    !provider_order_id ||
    !order_token_sha256 ||
    order_token_sha256.length < 32 ||
    !Number.isFinite(amount_pence) ||
    amount_pence <= 0 ||
    !currency
  ) {
    return null;
  }
  return {
    generation: Number.isFinite(generation) && generation > 0 ? generation : 1,
    payment_session_id,
    provider_order_id,
    order_token_sha256,
    order_token_suffix,
    amount_pence,
    currency,
    created_at: created_at || new Date(0).toISOString(),
  };
}

export function verifyGooglePayAttemptBinding(
  input: GooglePayAttemptVerifyInput,
): GooglePayAttemptVerifyResult {
  const snapshot = input.snapshot;
  if (!snapshot) {
    return {
      ok: false,
      code: "GOOGLE_PAY_ATTEMPT_MISSING",
      message: "Google Pay payment attempt context is missing. Start payment again.",
    };
  }
  const sessionId = trimStr(input.paymentSessionId);
  const orderId = trimStr(input.providerOrderId);
  const gatewaySha = trimStr(input.gatewayMerchantIdSha256).toLowerCase();
  if (!gatewaySha) {
    return {
      ok: false,
      code: "GOOGLE_PAY_ATTEMPT_GATEWAY_SHA_MISSING",
      message: "Google Pay order binding could not be verified. Start payment again.",
    };
  }
  if (sessionId && sessionId !== snapshot.payment_session_id) {
    return {
      ok: false,
      code: "GOOGLE_PAY_ATTEMPT_SESSION_MISMATCH",
      message: "Google Pay session no longer matches this payment. Start payment again.",
    };
  }
  if (!orderId || orderId !== snapshot.provider_order_id) {
    return {
      ok: false,
      code: "GOOGLE_PAY_ATTEMPT_ORDER_MISMATCH",
      message: "Google Pay was authorised for a different order. Start payment again.",
    };
  }
  if (gatewaySha !== snapshot.order_token_sha256) {
    return {
      ok: false,
      code: "GOOGLE_PAY_ATTEMPT_TOKEN_MISMATCH",
      message: "Google Pay was authorised for a different order token. Start payment again.",
    };
  }
  if (
    typeof input.amountPence === "number" &&
    Number.isFinite(input.amountPence) &&
    Math.round(input.amountPence) !== snapshot.amount_pence
  ) {
    return {
      ok: false,
      code: "GOOGLE_PAY_ATTEMPT_AMOUNT_MISMATCH",
      message: "Google Pay amount no longer matches this order. Start payment again.",
    };
  }
  const currency = trimStr(input.currency).toUpperCase();
  if (currency && currency !== snapshot.currency) {
    return {
      ok: false,
      code: "GOOGLE_PAY_ATTEMPT_CURRENCY_MISMATCH",
      message: "Google Pay currency no longer matches this order. Start payment again.",
    };
  }
  return { ok: true, snapshot };
}
