/**
 * Waafi-shaped Commission Wallet sandbox adapter (Phase 4).
 * Does NOT use booking PaymentProviderAdapter — keeps Stripe/Revolut isolated.
 */

export const WAAFI_SANDBOX_PROVIDER = "waafi_pay" as const;
export const WAAFI_SANDBOX_SIGNATURE_HEADER = "x-waafi-signature";

export type WaafiSandboxCreatePaymentInput = {
  amountMinor: number;
  currency: string;
  topupId: string;
  idempotencyKey: string;
};

export type WaafiSandboxCreatePaymentResult = {
  provider: typeof WAAFI_SANDBOX_PROVIDER;
  provider_transaction_id: string;
  sandbox: true;
  status: "PROCESSING";
};

export function createWaafiSandboxPayment(
  input: WaafiSandboxCreatePaymentInput,
): WaafiSandboxCreatePaymentResult {
  const topupId = String(input.topupId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return {
    provider: WAAFI_SANDBOX_PROVIDER,
    provider_transaction_id: `sandbox_waafi_${topupId}_${suffix}`,
    sandbox: true,
    status: "PROCESSING",
  };
}

/** Hex HMAC-SHA256 of raw body with webhook secret. */
export async function signWaafiSandboxWebhook(
  rawBody: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyWaafiSandboxWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string | null | undefined,
): Promise<boolean> {
  const provided = String(signatureHeader ?? "").trim().toLowerCase();
  const sec = String(secret ?? "").trim();
  if (!provided || !sec) return false;
  const expected = (await signWaafiSandboxWebhook(rawBody, sec)).toLowerCase();
  if (provided.length !== expected.length) return false;
  // Constant-time-ish compare
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

export type WaafiSandboxWebhookPayload = {
  event: "payment.succeeded" | "payment.failed" | "payment.expired" | "payment.reversed";
  provider: string;
  provider_transaction_id: string;
  amount_minor: number;
  currency: string;
  topup_id?: string;
  metadata?: Record<string, unknown>;
};

export function parseWaafiSandboxWebhookPayload(
  body: unknown,
): WaafiSandboxWebhookPayload | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const event = String(o.event ?? "");
  if (
    event !== "payment.succeeded"
    && event !== "payment.failed"
    && event !== "payment.expired"
    && event !== "payment.reversed"
  ) {
    return null;
  }
  const providerTxn = String(o.provider_transaction_id ?? "").trim();
  const currency = String(o.currency ?? "").trim().toUpperCase();
  const amount = Math.round(Number(o.amount_minor) || 0);
  if (!providerTxn) return null;
  // Reversal may omit amount (looked up from top-up row).
  if (event !== "payment.reversed" && (!currency || amount <= 0)) return null;
  return {
    event,
    provider: String(o.provider ?? WAAFI_SANDBOX_PROVIDER).trim().toLowerCase() || WAAFI_SANDBOX_PROVIDER,
    provider_transaction_id: providerTxn,
    amount_minor: amount > 0 ? amount : 0,
    currency: currency || "USD",
    topup_id: o.topup_id ? String(o.topup_id) : undefined,
    metadata: (o.metadata && typeof o.metadata === "object")
      ? o.metadata as Record<string, unknown>
      : undefined,
  };
}
