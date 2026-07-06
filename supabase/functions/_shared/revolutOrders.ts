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
}

/**
 * Create a Revolut order with manual capture.
 * Response includes `token` (used by the Revolut checkout JS widget) and
 * `checkout_url` (hosted redirect fallback).
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
        capture_mode: "manual",
        merchant_order_ext_ref: p.tripId,
        description: p.description ?? "ONECAB trip payment",
        metadata: p.metadata ?? {},
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
 * Read the active Revolut secret key + environment.
 * Prefers REVOLUT_MERCHANT_SECRET_KEY (Phase 2 explicit secret) with
 * REVOLUT_API_KEY kept as a fallback for pre-existing installations that
 * stored the merchant secret under the generic name.
 */
export function getRevolutMerchantConfig(): {
  secretKey: string;
  environment: ProviderEnvironment;
} {
  const key =
    Deno.env.get("REVOLUT_MERCHANT_SECRET_KEY") ??
    Deno.env.get("REVOLUT_API_KEY");
  if (!key) throw new Error("Revolut merchant secret key is not configured");
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
