/**
 * Step 9.4A — Revolut provider auth read-only audit SSOT.
 * GET-only wrappers. Never capture/refund/release/pay/create/write money.
 */
import {
  revolutBusinessRequest,
  revolutMerchantBaseUrl,
  revolutBusinessBaseUrl,
  type RevolutApiError,
} from "./revolutApi.ts";
import {
  retrieveRevolutOrder,
  type RevolutOrder,
} from "./revolutOrders.ts";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";

export const MERCHANT_GET_ALLOWLIST = ["GET /orders/{orderId}"] as const;
export const BUSINESS_GET_ALLOWLIST = ["GET /transaction/{transferId}"] as const;

export const FORBIDDEN_PROVIDER_MUTATION_PATHS = [
  "/capture",
  "/refund",
  "/cancel",
  "/release",
  "/pay",
  "/orders", // POST create — GET /orders/{id} is allow-listed separately
  "increment-authorisation",
  "webhook",
] as const;

export function maskProviderId(id: string | null | undefined): string | null {
  const s = String(id ?? "").trim();
  if (!s) return null;
  if (s.length <= 10) return `${s.slice(0, 2)}…${s.slice(-2)}`;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

export function maskSecretFingerprint(args: {
  prefix_class: string;
  len: number;
  value_sha256: string;
}): { prefix_class: string; len: number; sha256_12: string } {
  return {
    prefix_class: args.prefix_class,
    len: args.len,
    sha256_12: args.value_sha256.slice(0, 12),
  };
}

/** Source allow-list: retrieveRevolutOrder must be GET-only and not import pay/capture. */
export function assertMerchantRetrieveIsGetOnly(source: string): {
  ok: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (!source.includes("export async function retrieveRevolutOrder")) {
    reasons.push("retrieveRevolutOrder missing");
  }
  if (!source.includes("`/orders/${orderId}`") && !source.includes("/orders/${orderId}")) {
    reasons.push("order path missing");
  }
  // retrieveRevolutOrder body must not pass method POST
  const fn = source.slice(source.indexOf("export async function retrieveRevolutOrder"));
  const end = fn.indexOf("\nexport async function", 10);
  const body = end > 0 ? fn.slice(0, end) : fn.slice(0, 400);
  if (/method:\s*["']POST["']/.test(body)) reasons.push("retrieve uses POST");
  if (body.includes("/capture") || body.includes("/refund") || body.includes("/pay")) {
    reasons.push("mutate path in retrieve");
  }
  return { ok: reasons.length === 0, reasons };
}

export function assertBusinessAuditGetIsGetOnly(source: string): {
  ok: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  // Anchor on the real export (leading newline) so this assert's own
  // string literals cannot match first.
  const marker = "\nexport async function retrieveRevolutBusinessTransferReadOnly(";
  const start = source.indexOf(marker);
  if (start < 0) {
    reasons.push("audit GET wrapper missing");
    return { ok: false, reasons };
  }
  const rest = source.slice(start + 1);
  const end = rest.indexOf("\nexport ");
  const body = end > 0 ? rest.slice(0, end) : rest.slice(0, 800);
  if (!body.includes("/transaction/")) reasons.push("transaction path missing");
  if (!/method:\s*"GET"/.test(body)) reasons.push("GET method missing");
  if (/method:\s*"POST"/.test(body)) reasons.push("audit wrapper posts");
  if (body.includes("/pay")) reasons.push("audit wrapper references /pay");
  if (body.includes("/capture") || body.includes("/refund")) {
    reasons.push("mutate path in audit wrapper");
  }
  return { ok: reasons.length === 0, reasons };
}

export type MerchantAuthMatch = {
  http_ok: boolean;
  identity_match: boolean;
  amount_currency_match: boolean;
  provider_state_terminal: boolean;
  masked_order_id: string | null;
  masked_local_order_id: string | null;
  provider_state: string | null;
  provider_amount_minor: number | null;
  local_captured_pence: number;
  currency_match: boolean;
};

export function evaluateMerchantOrderAuthMatch(args: {
  localOrderId: string;
  localCapturedPence: number;
  localCurrency: string;
  order: RevolutOrder;
}): MerchantAuthMatch {
  const state = String(args.order.state ?? "").toUpperCase();
  const completed = Math.round(Number(args.order.completed_amount ?? args.order.amount ?? NaN));
  const currency = String(args.order.currency ?? "").toUpperCase();
  const localCur = String(args.localCurrency ?? "GBP").toUpperCase();
  const identity = String(args.order.id) === String(args.localOrderId);
  const amountOk = Number.isFinite(completed) && completed === args.localCapturedPence;
  const currencyOk = currency === localCur || (localCur === "GBP" && currency === "GBP");
  return {
    http_ok: true,
    identity_match: identity,
    amount_currency_match: amountOk && currencyOk,
    provider_state_terminal: state === "COMPLETED",
    masked_order_id: maskProviderId(args.order.id),
    masked_local_order_id: maskProviderId(args.localOrderId),
    provider_state: state || null,
    provider_amount_minor: Number.isFinite(completed) ? completed : null,
    local_captured_pence: args.localCapturedPence,
    currency_match: currencyOk,
  };
}

export type BusinessAuthMatch = {
  http_ok: boolean;
  identity_match: boolean;
  amount_currency_match: boolean;
  provider_state_terminal: boolean;
  reference_match: boolean;
  masked_transfer_id: string | null;
  masked_local_payment_id: string | null;
  provider_state: string | null;
  provider_amount_pence: number | null;
  local_amount_pence: number;
};

/** Business amounts are major units (e.g. 12.75); convert to pence for compare. */
export function businessAmountToPence(amount: unknown, currency: string): number | null {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const cur = String(currency ?? "GBP").toUpperCase();
  // GBP/EUR/USD minor = *100
  if (["GBP", "EUR", "USD"].includes(cur)) return Math.round(n * 100);
  return Math.round(n * 100);
}

export function evaluateBusinessTransferAuthMatch(args: {
  localPaymentId: string;
  localAmountPence: number;
  localCurrency: string;
  localPaymentReference: string | null;
  transfer: Record<string, unknown>;
}): BusinessAuthMatch {
  const id = String(args.transfer.id ?? args.transfer.transaction_id ?? "");
  const state = String(args.transfer.state ?? args.transfer.provider_state ?? "").toLowerCase();
  const currency = String(args.transfer.currency ?? args.localCurrency ?? "GBP").toUpperCase();
  const amountPence = businessAmountToPence(args.transfer.amount, currency);
  const ref = String(
    args.transfer.reference ?? args.transfer.payment_reference ?? "",
  );
  const identity = id === String(args.localPaymentId);
  const amountOk = amountPence === args.localAmountPence;
  const currencyOk = currency === String(args.localCurrency ?? "GBP").toUpperCase();
  const refOk = !args.localPaymentReference
    || ref === args.localPaymentReference
    || ref.includes(String(args.localPaymentReference).slice(0, 24));
  const terminal = ["completed", "paid"].includes(state);
  return {
    http_ok: true,
    identity_match: identity,
    amount_currency_match: amountOk && currencyOk,
    provider_state_terminal: terminal,
    reference_match: refOk,
    masked_transfer_id: maskProviderId(id),
    masked_local_payment_id: maskProviderId(args.localPaymentId),
    provider_state: state || null,
    provider_amount_pence: amountPence,
    local_amount_pence: args.localAmountPence,
  };
}

/** Production Merchant GET — same helper capture uses for retrieve. */
export async function retrieveMerchantOrderReadOnly(args: {
  environment: ProviderEnvironment;
  secretKey: string;
  orderId: string;
}): Promise<RevolutOrder> {
  return await retrieveRevolutOrder(args.environment, args.secretKey, args.orderId);
}

/**
 * Audit-only Business GET /transaction/:id.
 * Does not call relay, /pay, or any local finalizer.
 */
export async function retrieveRevolutBusinessTransferReadOnly(args: {
  environment: ProviderEnvironment;
  accessToken: string;
  transferId: string;
}): Promise<Record<string, unknown>> {
  const id = encodeURIComponent(args.transferId);
  return await revolutBusinessRequest<Record<string, unknown>>(
    args.environment,
    args.accessToken,
    `/transaction/${id}`,
    { method: "GET" },
  );
}

export function classifyAuthFailure(err: unknown): {
  kind: "missing_credential" | "unauthorized" | "forbidden" | "mismatch" | "unavailable" | "other";
  status: number | null;
  message: string;
  retry_with_other_credential: false;
  financial_action: "NONE";
} {
  const status = typeof err === "object" && err && "status" in err
    ? Number((err as RevolutApiError).status)
    : null;
  const message = err instanceof Error
    ? err.message
    : (typeof err === "object" && err && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err));
  let kind: "missing_credential" | "unauthorized" | "forbidden" | "mismatch" | "unavailable" | "other" =
    "other";
  if (/not configured|missing|empty credential/i.test(message) || status === 0 && /missing/i.test(message)) {
    kind = "missing_credential";
  } else if (status === 401) kind = "unauthorized";
  else if (status === 403) kind = "forbidden";
  else if (status != null && status >= 500) kind = "unavailable";
  else if (/timeout|abort|unreachable/i.test(message)) kind = "unavailable";
  else if (/mismatch/i.test(message)) kind = "mismatch";
  return {
    kind,
    status,
    message: message.slice(0, 200),
    retry_with_other_credential: false,
    financial_action: "NONE",
  };
}

export function liveBaseUrls(environment: ProviderEnvironment = "live"): {
  merchant: string;
  business: string;
} {
  return {
    merchant: revolutMerchantBaseUrl(environment),
    business: revolutBusinessBaseUrl(environment),
  };
}
