// Revolut Merchant Orders API wrapper used by customer-checkout edge functions.
// All amounts are integer minor units (e.g. pence) — Revolut's Orders API
// (versions 2024-09-01+) accepts and returns amounts as integer minor units.
import { revolutMerchantRequest } from "./revolutApi.ts";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";

export type RevolutOrderState =
  | "PENDING"
  | "PROCESSING"
  | "AUTHORISED"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED"
  | "REFUNDED";

export interface RevolutOrder {
  id: string;
  token?: string;
  public_id?: string;
  checkout_url?: string;
  state?: RevolutOrderState | string;
  amount?: number;
  currency?: string;
  capture_mode?: string;
  merchant_order_ext_ref?: string;
  metadata?: Record<string, string>;
}

export interface CreateOrderParams {
  environment: ProviderEnvironment;
  secretKey: string;
  amountMinor: number;
  currency: string;                       // ISO 4217, uppercased inside
  tripId: string;
  description?: string;
  metadata?: Record<string, string>;
  captureMode?: "manual" | "automatic";   // Defaults to "manual" (pre-auth flow).
  merchantOrderExtRef?: string;           // Override default (trip id) — required for recovery attempts.
}

/**
 * Create a Revolut order. Defaults to manual capture (pre-auth flow used at
 * booking time). Recovery attempts pass captureMode: "automatic" because the
 * final fare is already known and there is no separate capture step.
 */
export async function createRevolutOrder(p: CreateOrderParams): Promise<RevolutOrder> {
  return await revolutMerchantRequest<RevolutOrder>(
    p.environment,
    p.secretKey,
    "/orders",
    {
      method: "POST",
      body: JSON.stringify({
        amount: p.amountMinor,
        currency: p.currency.toUpperCase(),
        capture_mode: p.captureMode ?? "manual",
        merchant_order_ext_ref: p.merchantOrderExtRef ?? p.tripId,
        description: p.description ?? "ONECAB trip payment",
        metadata: p.metadata ?? {},
      }),
    },
  );
}


/**
 * Hosted checkout URL for an order. Revolut only returns `checkout_url` on
 * some API versions/flows; when absent it is deterministically derivable from
 * the order token (public id). Never return an empty link.
 */
export function resolveRevolutCheckoutUrl(
  order: RevolutOrder | null | undefined,
  environment: ProviderEnvironment,
): string | null {
  const direct = typeof order?.checkout_url === "string" ? order.checkout_url.trim() : "";
  if (direct) return direct;
  const token = (order?.token ?? order?.public_id ?? "").toString().trim();
  if (!token) return null;
  const host = environment === "live"
    ? "https://checkout.revolut.com"
    : "https://sandbox-checkout.revolut.com";
  return `${host}/payment-link/${token}`;
}

export interface RevolutOrderPayment {
  id?: string;
  state?: string;
  order_id?: string;
  decline_reason?: string;
  [key: string]: unknown;
}

/**
 * Merchant-initiated (off-session) charge against a customer's saved Revolut
 * payment method. Used by payment recovery so admins do not always have to
 * send a link. May still fail when the issuer demands SCA — callers must fall
 * back to the hosted checkout link in that case.
 */
export async function payRevolutOrderWithSavedPaymentMethod(params: {
  environment: ProviderEnvironment;
  secretKey: string;
  orderId: string;
  savedPaymentMethodId: string;
  initiator?: "merchant" | "customer";
}): Promise<RevolutOrderPayment> {
  return await revolutMerchantRequest<RevolutOrderPayment>(
    params.environment,
    params.secretKey,
    `/orders/${params.orderId}/payments`,
    {
      method: "POST",
      body: JSON.stringify({
        saved_payment_method: {
          type: "card",
          id: params.savedPaymentMethodId,
          initiator: params.initiator ?? "merchant",
        },
      }),
    },
  );
}

export async function retrieveRevolutOrder(
  environment: ProviderEnvironment,
  secretKey: string,
  orderId: string,
): Promise<RevolutOrder> {
  return await revolutMerchantRequest<RevolutOrder>(
    environment,
    secretKey,
    `/orders/${orderId}`,
  );
}

/** Manual capture of an authorised order. Amount defaults to full authorised. */
export async function captureRevolutOrder(
  environment: ProviderEnvironment,
  secretKey: string,
  orderId: string,
  amountMinor?: number,
): Promise<RevolutOrder> {
  return await revolutMerchantRequest<RevolutOrder>(
    environment,
    secretKey,
    `/orders/${orderId}/capture`,
    {
      method: "POST",
      body: JSON.stringify(amountMinor != null ? { amount: amountMinor } : {}),
    },
  );
}

/** Cancel an authorised-but-uncaptured order (releases customer hold). */
export async function cancelRevolutOrder(
  environment: ProviderEnvironment,
  secretKey: string,
  orderId: string,
): Promise<RevolutOrder> {
  return await revolutMerchantRequest<RevolutOrder>(
    environment,
    secretKey,
    `/orders/${orderId}/cancel`,
    { method: "POST", body: "{}" },
  );
}

/** Refund all or part of a captured order. */
export async function refundRevolutOrder(
  environment: ProviderEnvironment,
  secretKey: string,
  orderId: string,
  amountMinor?: number,
  reason?: string,
  currency: string = "GBP",
): Promise<{ id?: string; state?: string }> {
  const body: Record<string, unknown> = {};
  if (amountMinor != null) {
    body.amount = amountMinor;
    body.currency = currency.toUpperCase();
  }
  if (reason) body.reason = reason.slice(0, 200);
  return await revolutMerchantRequest(
    environment,
    secretKey,
    `/orders/${orderId}/refund`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/**
 * Read the active Revolut secret key + environment from canonical edge env.
 */
export function getRevolutMerchantConfig(): {
  secretKey: string;
  environment: ProviderEnvironment;
} {
  const key = Deno.env.get("REVOLUT_MERCHANT_SECRET_KEY");
  if (!key) throw new Error("Revolut merchant secret key is not configured (REVOLUT_MERCHANT_SECRET_KEY)");
  const environment: ProviderEnvironment = key.startsWith("sk_sandbox") ? "sandbox" : "live";
  return { secretKey: key, environment };
}

/** Map a Revolut order state to our internal trips.payment_status vocabulary. */
export function mapRevolutStateToPaymentStatus(
  state: string | undefined,
): "authorized" | "captured" | "canceled" | "failed" | "refunded" | null {
  switch ((state ?? "").toUpperCase()) {
    case "AUTHORISED":
    case "PROCESSING":
      return "authorized";
    case "COMPLETED":
      return "captured";
    case "CANCELLED":
      return "canceled";
    case "FAILED":
      return "failed";
    case "REFUNDED":
      return "refunded";
    default:
      return null;
  }
}
