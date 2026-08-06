// Revolut Merchant Orders API wrapper used by customer-checkout edge functions.
// All amounts are integer minor units (e.g. pence) — Revolut's Orders API
// (versions 2024-09-01+) accepts and returns amounts as integer minor units.
import {
  revolutMerchantRequest,
  type RevolutApiError,
} from "./revolutApi.ts";
import type { RevolutCustomerRef } from "./revolutCustomers.ts";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";

/**
 * Increment authorisation requires a Merchant API version that exposes
 * POST /orders/{id}/increment-authorisation. Scoped to increment only —
 * other order ops keep REVOLUT_MERCHANT_API_VERSION (2024-09-01).
 * @see https://developer.revolut.com/docs/merchant/increment-authorisation
 */
export const REVOLUT_INCREMENT_API_VERSION = "2026-04-20";

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
  /** Provider-confirmed authorised total (minor units) for pre-auth / increment flows. */
  authorised_amount?: number;
  currency?: string;
  capture_mode?: string;
  /** Required for same-order incremental authorisation. */
  authorisation_type?: string;
  merchant_order_ext_ref?: string;
  metadata?: Record<string, string>;
  payments?: Array<{
    id?: string;
    state?: string;
    amount?: number;
    authorised_amount?: number;
    payment_method?: {
      type?: string;
      card_brand?: string;
    };
  }>;
  incremental_authorisations?: Array<{
    amount?: number;
    state?: string;
    created_at?: string;
  }>;
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
  /**
   * When true (default for booking holds), sets authorisation_type=pre_authorisation
   * so same-order incremental authorisation is eligible later.
   */
  enableIncrementalAuthorisation?: boolean;
}

/**
 * Create a Revolut order with manual capture.
 * Booking holds default to authorisation_type=pre_authorisation (required for
 * later same-order increments). Response includes `token` for native checkout.
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

  const enableIncrement = p.enableIncrementalAuthorisation !== false;

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
        ...(enableIncrement ? { authorisation_type: "pre_authorisation" } : {}),
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

/** Revolut Address shape for Google Pay Pay-for-order (official Merchant API). */
export type GooglePayBillingAddress = {
  street_line_1?: string;
  street_line_2?: string;
  region?: string;
  city?: string;
  country_code?: string;
  postcode?: string;
};

export type PayGooglePayParams = {
  environment: ProviderEnvironment;
  secretKey: string;
  orderId: string;
  googlePayToken: string;
  cardholderName?: string | null;
  billingAddress?: GooglePayBillingAddress | null;
};

/**
 * Submit encrypted Google Pay token to Revolut Pay-for-order.
 * Official: gateway=revolut, gatewayMerchantId=order token (client-side).
 * Body: payment_method.type=google_pay + token (+ cardholder_name / billing_address).
 * Never logs the token.
 */
export async function payRevolutOrderWithGooglePay(
  p: PayGooglePayParams,
): Promise<RevolutOrderPayment> {
  const billing = p.billingAddress ?? {};
  const country = (billing.country_code ?? "GB").trim().toUpperCase() || "GB";
  const postcode = (billing.postcode ?? "").trim() || "000000";
  const cardholder =
    (typeof p.cardholderName === "string" && p.cardholderName.trim()) ||
    "Cardholder";

  return await revolutMerchantRequest<RevolutOrderPayment>(
    p.environment,
    p.secretKey,
    `/orders/${p.orderId}/payments`,
    {
      method: "POST",
      body: JSON.stringify({
        payment_method: {
          type: "google_pay",
          token: p.googlePayToken,
          cardholder_name: cardholder,
          billing_address: {
            street_line_1: billing.street_line_1,
            street_line_2: billing.street_line_2,
            region: billing.region,
            city: billing.city,
            country_code: country,
            postcode,
          },
          environment: {
            type: "browser",
            time_zone_utc_offset: 0,
            color_depth: 48,
            screen_width: 1080,
            screen_height: 1920,
            java_enabled: false,
            challenge_window_width: 360,
            browser_url: "https://onecab.app",
            locale: "en-GB",
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

/**
 * Provider-confirmed authorised total in minor units.
 * Prefer authorised_amount; fall back to order.amount when still AUTHORISED.
 */
export function revolutProviderAuthorisedTotalPence(
  order: RevolutOrder | null | undefined,
): number {
  if (!order) return 0;
  const auth = Number(order.authorised_amount);
  if (Number.isFinite(auth) && auth > 0) return Math.round(auth);
  const amt = Number(order.amount);
  if (Number.isFinite(amt) && amt > 0) return Math.round(amt);
  return 0;
}

export type RevolutIncrementOutcomeClass =
  | "confirmed"
  | "processing"
  | "declined"
  | "unsupported"
  | "customer_action_required"
  | "retryable"
  | "terminal"
  | "unknown";

export type IncrementRevolutOrderAuthorisationResult =
  | {
    ok: true;
    outcome: "confirmed" | "processing";
    order: RevolutOrder;
    previousAuthorisedPence: number;
    requestedTargetTotalPence: number;
    providerConfirmedTotalPence: number;
    apiVersion: string;
  }
  | {
    ok: false;
    outcome: Exclude<RevolutIncrementOutcomeClass, "confirmed" | "processing">;
    order: RevolutOrder | null;
    previousAuthorisedPence: number;
    requestedTargetTotalPence: number;
    providerConfirmedTotalPence: number;
    httpStatus: number | null;
    errorCode: string | null;
    message: string;
    apiVersion: string;
  };

/**
 * Same-order incremental authorisation.
 *
 * Revolut contract (Merchant API 2026-04-20+):
 * POST /orders/{order_id}/increment-authorisation
 * body.amount = NEW TOTAL authorised amount (minor units), NOT the delta.
 *
 * Prerequisites (caller must verify eligibility first):
 * - capture_mode = manual
 * - authorisation_type = pre_authorisation
 * - state = authorised
 * - card payment method
 *
 * Never creates a new order. HTTP 200 alone is not success — provider-confirmed
 * authorised total must cover the requested target (or state=processing).
 */
export async function incrementRevolutOrderAuthorisation(args: {
  environment: ProviderEnvironment;
  secretKey: string;
  orderId: string;
  /** New cumulative authorised total in minor units (not the increase delta). */
  targetTotalAuthorisedPence: number;
  currency?: string;
  /** Optional merchant reference for the increment operation. */
  reference?: string;
  /** Previous provider-confirmed total used for response validation. */
  previousAuthorisedPence?: number;
}): Promise<IncrementRevolutOrderAuthorisationResult> {
  const apiVersion = REVOLUT_INCREMENT_API_VERSION;
  const orderId = String(args.orderId ?? "").trim();
  const target = Math.round(Number(args.targetTotalAuthorisedPence));
  const previous = Math.max(0, Math.round(Number(args.previousAuthorisedPence ?? 0)));

  if (!orderId) {
    return {
      ok: false,
      outcome: "terminal",
      order: null,
      previousAuthorisedPence: previous,
      requestedTargetTotalPence: target,
      providerConfirmedTotalPence: previous,
      httpStatus: null,
      errorCode: "missing_order_id",
      message: "Missing Revolut order id for increment.",
      apiVersion,
    };
  }
  if (!Number.isFinite(target) || target < 1) {
    return {
      ok: false,
      outcome: "terminal",
      order: null,
      previousAuthorisedPence: previous,
      requestedTargetTotalPence: target,
      providerConfirmedTotalPence: previous,
      httpStatus: null,
      errorCode: "invalid_target_total",
      message: "Increment target total must be a positive integer (minor units).",
      apiVersion,
    };
  }
  if (previous > 0 && target < previous) {
    return {
      ok: false,
      outcome: "terminal",
      order: null,
      previousAuthorisedPence: previous,
      requestedTargetTotalPence: target,
      providerConfirmedTotalPence: previous,
      httpStatus: null,
      errorCode: "target_below_current",
      message: "Increment target cannot be below the current authorised total.",
      apiVersion,
    };
  }

  const body: Record<string, unknown> = { amount: target };
  if (args.reference) body.reference = String(args.reference).slice(0, 100);

  try {
    const order = await revolutMerchantRequest<RevolutOrder>(
      args.environment,
      args.secretKey,
      `/orders/${orderId}/increment-authorisation`,
      { method: "POST", body: JSON.stringify(body) },
      apiVersion,
    );

    const confirmed = revolutProviderAuthorisedTotalPence(order);
    const state = String(order.state ?? "").toUpperCase();

    if (state === "PROCESSING" || state === "PENDING") {
      return {
        ok: true,
        outcome: "processing",
        order,
        previousAuthorisedPence: previous,
        requestedTargetTotalPence: target,
        providerConfirmedTotalPence: confirmed > 0 ? confirmed : previous,
        apiVersion,
      };
    }

    if (confirmed >= target && (state === "AUTHORISED" || state === "AUTHORIZED")) {
      return {
        ok: true,
        outcome: "confirmed",
        order,
        previousAuthorisedPence: previous,
        requestedTargetTotalPence: target,
        providerConfirmedTotalPence: confirmed,
        apiVersion,
      };
    }

    // HTTP 200 but authorised total did not rise to target — treat as unknown.
    return {
      ok: false,
      outcome: "unknown",
      order,
      previousAuthorisedPence: previous,
      requestedTargetTotalPence: target,
      providerConfirmedTotalPence: confirmed,
      httpStatus: 200,
      errorCode: "authorised_total_not_increased",
      message:
        "Increment response did not confirm the requested authorised total; retrieve required.",
      apiVersion,
    };
  } catch (err) {
    const apiErr = err as RevolutApiError;
    const status = typeof apiErr?.status === "number" ? apiErr.status : null;
    const bodyObj = apiErr?.body && typeof apiErr.body === "object"
      ? apiErr.body as Record<string, unknown>
      : null;
    const code = bodyObj
      ? String(bodyObj.code ?? bodyObj.error_code ?? bodyObj.type ?? "") || null
      : null;
    const msg = String(apiErr?.message ?? "Revolut increment failed");
    const lower = `${msg} ${code ?? ""}`.toLowerCase();

    let outcome: Exclude<RevolutIncrementOutcomeClass, "confirmed" | "processing"> =
      "retryable";
    if (status === 401 || status === 403) outcome = "terminal";
    else if (status === 404) outcome = "terminal";
    else if (status === 409 || status === 422) {
      if (
        /unsupport|not.?support|authorisation_type|capture_mode|pre_authorisation/i
          .test(lower)
      ) {
        outcome = "unsupported";
      } else if (/declin|insufficient|do.?not.?honou|do.?not.?honor/i.test(lower)) {
        outcome = "declined";
      } else if (/3ds|challenge|authenticat|action.?required|sca/i.test(lower)) {
        outcome = "customer_action_required";
      } else {
        outcome = "terminal";
      }
    } else if (status === 400) {
      if (/unsupport|not.?support|authorisation_type|capture_mode/i.test(lower)) {
        outcome = "unsupported";
      } else if (/declin/i.test(lower)) {
        outcome = "declined";
      } else {
        outcome = "terminal";
      }
    } else if (status == null || status === 0 || status >= 500 || status === 429) {
      outcome = "retryable";
    } else {
      outcome = "unknown";
    }

    return {
      ok: false,
      outcome,
      order: null,
      previousAuthorisedPence: previous,
      requestedTargetTotalPence: target,
      providerConfirmedTotalPence: previous,
      httpStatus: status,
      errorCode: code,
      message: msg,
      apiVersion,
    };
  }
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
