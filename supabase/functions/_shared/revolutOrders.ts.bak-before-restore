// Revolut Merchant Orders API wrapper used by customer-checkout edge functions.
// All amounts are integer minor units (e.g. pence) — Revolut's Orders API
// (versions 2024-09-01+) accepts and returns amounts as integer minor units.
import { revolutMerchantRequest, validateRevolutMerchantSecret } from "./revolutApi.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
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

export type GooglePayBillingAddress = {
  street_line_1?: string;
  street_line_2?: string;
  region?: string;
  city?: string;
  country_code?: string;
  postcode?: string;
};

/**
 * Pay an existing Revolut order with a Google Pay encrypted token.
 * Server-side only — never call from the mobile app with a secret key.
 */
export async function payRevolutOrderWithGooglePay(args: {
  environment: ProviderEnvironment;
  secretKey: string;
  orderId: string;
  googlePayToken: string;
  cardholderName?: string | null;
  billingAddress?: GooglePayBillingAddress | null;
}): Promise<RevolutOrder> {
  const paymentMethod: Record<string, unknown> = {
    type: "google_pay",
    token: args.googlePayToken,
  };
  if (args.cardholderName) {
    paymentMethod.cardholder_name = args.cardholderName;
  }
  if (args.billingAddress) {
    paymentMethod.billing_address = args.billingAddress;
  }

  return await revolutMerchantRequest<RevolutOrder>(
    args.environment,
    args.secretKey,
    `/orders/${args.orderId}/payments`,
    {
      method: "POST",
      body: JSON.stringify({ payment_method: paymentMethod }),
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

/**
 * Prefer LIVE vault secret_key (sk_) — matches pk_ from get-revolut-checkout-client-config.
 * Falls back to REVOLUT_MERCHANT_SECRET_KEY env when vault is empty.
 */
export async function getRevolutMerchantConfigFromVault(
  supabase: SupabaseClient,
): Promise<{ secretKey: string; environment: ProviderEnvironment }> {
  const { data } = await supabase
    .from("payment_provider_vault")
    .select("secret_value")
    .eq("provider", "revolut")
    .eq("environment", "live")
    .eq("secret_name", "secret_key")
    .maybeSingle();

  const validation = validateRevolutMerchantSecret(data?.secret_value as string | undefined);
  if (validation.ok) {
    return { secretKey: validation.normalized, environment: "live" };
  }

  return getRevolutMerchantConfig();
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
