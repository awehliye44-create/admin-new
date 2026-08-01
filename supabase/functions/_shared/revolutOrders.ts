// Revolut Merchant Orders API wrapper used by customer-checkout edge functions.
// All amounts are integer minor units (e.g. pence) — Revolut's Orders API
// (versions 2024-09-01+) accepts and returns amounts as integer minor units.
import { revolutMerchantRequest } from "./revolutApi.ts";
import type { RevolutCustomerRef } from "./revolutCustomers.ts";
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

export type RevolutOrderPayment = {
  id: string;
  order_id?: string;
  token?: string;
  state?: string;
  amount?: number;
  currency?: string;
  authentication_challenge?: {
    type?: string;
    acs_url?: string;
  };
  payment_method?: {
    type?: string;
    id?: string;
    card_brand?: string;
    card_last_four?: string;
    last_four?: string;
    saved_payment_method?: {
      id?: string;
      type?: string;
    };
  };
  saved_payment_method?: {
    id?: string;
    type?: string;
  };
  decline_reason?: string;
};

export interface CreateOrderParams {
  environment: ProviderEnvironment;
  secretKey: string;
  amountMinor: number;
  currency: string;                       // ISO 4217, uppercased inside
  tripId: string;
  description?: string;
  metadata?: Record<string, string>;
  /** Required for savePaymentMethodFor / saved card reuse in Revolut Checkout. */
  customer?: RevolutCustomerRef;
}

/**
 * Create a Revolut order with manual capture.
 * Response includes `token` (used by the Revolut checkout JS widget) and
 * `checkout_url` (hosted redirect fallback).
 */
export async function createRevolutOrder(p: CreateOrderParams): Promise<RevolutOrder> {
  const customerPayload =
    p.customer?.id
      ? { id: p.customer.id }
      : p.customer?.email
      ? {
        email: p.customer.email,
        ...(p.customer.full_name ? { full_name: p.customer.full_name } : {}),
      }
      : undefined;

  return await revolutMerchantRequest<RevolutOrder>(
    p.environment,
    p.secretKey,
    "/orders",
    {
      method: "POST",
      body: JSON.stringify({
        amount: p.amountMinor,
        currency: p.currency.toUpperCase(),
        capture_mode: "manual",
        merchant_order_ext_ref: p.tripId,
        description: p.description ?? "ONECAB trip payment",
        metadata: p.metadata ?? {},
        ...(customerPayload ? { customer: customerPayload } : {}),
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

export async function listRevolutOrderPayments(
  environment: ProviderEnvironment,
  secretKey: string,
  orderId: string,
): Promise<RevolutOrderPayment[]> {
  const data = await revolutMerchantRequest<RevolutOrderPayment[] | { payments?: RevolutOrderPayment[] }>(
    environment,
    secretKey,
    `/orders/${orderId}/payments`,
    { method: "GET" },
  );
  if (Array.isArray(data)) return data;
  return data.payments ?? [];
}

export async function payRevolutOrderWithSavedCard(
  environment: ProviderEnvironment,
  secretKey: string,
  orderId: string,
  savedPaymentMethodId: string,
): Promise<RevolutOrderPayment> {
  return await revolutMerchantRequest<RevolutOrderPayment>(
    environment,
    secretKey,
    `/orders/${orderId}/payments`,
    {
      method: "POST",
      body: JSON.stringify({
        saved_payment_method: {
          type: "card",
          id: savedPaymentMethodId,
          initiator: "customer",
          environment: {
            type: "browser",
            time_zone_utc_offset: 0,
            color_depth: 24,
            screen_width: 390,
            screen_height: 844,
            java_enabled: false,
            challenge_window_width: 390,
            browser_url: "https://onecab.app",
          },
        },
      }),
    },
  );
}

export async function retrieveRevolutOrderPayment(
  environment: ProviderEnvironment,
  secretKey: string,
  paymentId: string,
): Promise<RevolutOrderPayment> {
  return await revolutMerchantRequest<RevolutOrderPayment>(
    environment,
    secretKey,
    `/payments/${paymentId}`,
    { method: "GET" },
    "2026-04-20",
  );
}

export function extractRevolutSavedCardPaymentMethodId(
  payment: RevolutOrderPayment | null | undefined,
): string | null {
  if (!payment) return null;

  const nestedSaved = payment.payment_method?.saved_payment_method?.id
    ?? payment.saved_payment_method?.id;
  if (typeof nestedSaved === "string" && nestedSaved.trim()) {
    return nestedSaved.trim();
  }

  // Never use payment_method.id — that is a one-time payment reference, not reusable.
  return null;
}

const REVOLUT_PAYMENT_AUTHORISED = new Set([
  "AUTHORISED",
  "AUTHORIZED",
  "CAPTURED",
  "COMPLETED",
]);

const REVOLUT_PAYMENT_FAILED = new Set([
  "DECLINED",
  "FAILED",
  "CANCELLED",
  "CANCELED",
]);

export function isRevolutPaymentAuthorisedState(state: string | null | undefined): boolean {
  return REVOLUT_PAYMENT_AUTHORISED.has(String(state ?? "").toUpperCase());
}

export function isRevolutPaymentFailedState(state: string | null | undefined): boolean {
  return REVOLUT_PAYMENT_FAILED.has(String(state ?? "").toUpperCase());
}

export function isRevolutPaymentAuthenticationChallenge(
  payment: RevolutOrderPayment | null | undefined,
): boolean {
  return String(payment?.state ?? "").toLowerCase() === "authentication_challenge";
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
): Promise<{ id?: string; state?: string }> {
  const body: Record<string, unknown> = {};
  if (amountMinor != null) body.amount = amountMinor;
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
