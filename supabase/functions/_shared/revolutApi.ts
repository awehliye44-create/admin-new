import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";

export type RevolutApiError = {
  message: string;
  status: number;
  body?: unknown;
};

export const REVOLUT_MERCHANT_COLLECTION_PROBE = "GET /api/orders?limit=1";

/** Modern Merchant API (2024-09-01+). Legacy /api/1.0/* is deprecated and can 401 valid keys. */
export const REVOLUT_MERCHANT_API_VERSION = "2024-09-01";

export function revolutHttpStatusLabel(status: number): string {
  switch (status) {
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Endpoint not found";
    case 429:
      return "Rate limited";
    case 400:
      return "Bad request";
    case 500:
      return "Internal server error";
    case 502:
      return "Bad gateway";
    case 503:
      return "Service unavailable";
    default:
      return `HTTP ${status}`;
  }
}

export function parseRevolutErrorBody(body: unknown): {
  revolut_message: string | null;
  revolut_error_code: string | null;
} {
  if (!body || typeof body !== "object") {
    return { revolut_message: typeof body === "string" ? body : null, revolut_error_code: null };
  }
  const record = body as Record<string, unknown>;
  const revolut_message = [
    record.message,
    record.error_description,
    record.error,
  ].find((v) => typeof v === "string" && v.trim()) as string | undefined ?? null;
  const codeCandidate = [
    record.code,
    record.error_code,
    record.errorCode,
    record.type,
  ].find((v) => (typeof v === "string" && v.trim()) || typeof v === "number");
  const revolut_error_code = codeCandidate != null ? String(codeCandidate) : null;
  return { revolut_message, revolut_error_code };
}

export function normalizeRevolutMerchantSecret(raw: string): string {
  let key = raw.trim();
  if (/^bearer\s+/i.test(key)) {
    key = key.replace(/^bearer\s+/i, "").trim();
  }
  return key;
}

/** Revolut Merchant secrets are server-side `sk_…` keys — never public checkout keys. */
export function validateRevolutMerchantSecret(
  secretKey: string | null | undefined,
  publishableKey?: string | null,
): { ok: true; normalized: string } | { ok: false; message: string } {
  const normalized = normalizeRevolutMerchantSecret(secretKey ?? "");
  if (!normalized) {
    return {
      ok: false,
      message: "Revolut Production API Secret key is missing. Save the `sk_…` key from Merchant API → Secret key (not the Public key).",
    };
  }
  if (/^pk_/i.test(normalized)) {
    return {
      ok: false,
      message: "The Secret key field contains a Public key (`pk_…`). Swap them: Public key → API key field, Secret key (`sk_…`) → Secret key field.",
    };
  }
  if (!/^sk_/i.test(normalized)) {
    const publishableLooksSecret = publishableKey
      && /^sk_/i.test(normalizeRevolutMerchantSecret(publishableKey));
    if (publishableLooksSecret) {
      return {
        ok: false,
        message: "Keys appear swapped: the `sk_…` value is in the Public/API key field. Move Production API Secret key (`sk_…`) to Secret key.",
      };
    }
    return {
      ok: false,
      message: "Revolut Secret key must start with `sk_`. Use Production API Secret key from Revolut Business → Merchant API (not the Public key).",
    };
  }
  return { ok: true, normalized };
}

export function formatRevolutApiFailure(
  err: RevolutApiError,
  apiSurface: "merchant" | "business",
): {
  message: string;
  http_status: number;
  http_status_label: string;
  revolut_error_code: string | null;
  revolut_message: string | null;
  api_surface: "merchant" | "business";
} {
  const http_status = err.status;
  const http_status_label = revolutHttpStatusLabel(http_status);
  const parsed = parseRevolutErrorBody(err.body);
  const revolut_message = parsed.revolut_message ?? err.message;
  const revolut_error_code = parsed.revolut_error_code;

  if (http_status === 0) {
    return {
      message: revolut_message,
      http_status,
      http_status_label: "Invalid credentials",
      revolut_error_code,
      revolut_message,
      api_surface: apiSurface,
    };
  }

  const message = [
    `Revolut ${apiSurface} API: ${http_status} ${http_status_label}`,
    revolut_error_code ? `Code: ${revolut_error_code}` : null,
    revolut_message && !revolut_message.includes(String(http_status)) ? revolut_message : null,
  ].filter(Boolean).join(" — ");

  return {
    message,
    http_status,
    http_status_label,
    revolut_error_code,
    revolut_message,
    api_surface: apiSurface,
  };
}

export function revolutBusinessBaseUrl(environment: ProviderEnvironment): string {
  return environment === "live"
    ? "https://b2b.revolut.com/api/1.0"
    : "https://sandbox-b2b.revolut.com/api/1.0";
}

export function revolutMerchantBaseUrl(environment: ProviderEnvironment): string {
  return environment === "live"
    ? "https://merchant.revolut.com/api"
    : "https://sandbox-merchant.revolut.com/api";
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function revolutMerchantRequest<T = Record<string, unknown>>(
  environment: ProviderEnvironment,
  secretKey: string,
  path: string,
  init?: RequestInit,
  apiVersion = REVOLUT_MERCHANT_API_VERSION,
): Promise<T> {
  const normalizedKey = normalizeRevolutMerchantSecret(secretKey);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const res = await fetch(`${revolutMerchantBaseUrl(environment)}${normalizedPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${normalizedKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Revolut-Api-Version": apiVersion,
      ...(init?.headers ?? {}),
    },
  });
  const body = await parseJsonSafe(res);
  if (!res.ok) {
    const parsed = parseRevolutErrorBody(body);
    const message = parsed.revolut_message
      ?? (typeof body === "object" && body && "message" in body
        ? String((body as { message?: string }).message)
        : `Revolut Merchant API error (${res.status})`);
    throw { message, status: res.status, body } satisfies RevolutApiError;
  }
  return body as T;
}

export async function testRevolutMerchantConnection(
  environment: ProviderEnvironment,
  secretKey: string,
  publishableKey?: string | null,
): Promise<{ endpoint_tested: string; api_version: string }> {
  const validation = validateRevolutMerchantSecret(secretKey, publishableKey);
  if (!validation.ok) {
    throw {
      message: validation.message,
      status: 0,
      body: { code: "invalid_secret_format" },
    } satisfies RevolutApiError;
  }

  const endpoint = "/orders?limit=1";
  const apiVersions = [REVOLUT_MERCHANT_API_VERSION, "2026-04-20", "2024-05-01"] as const;
  let lastErr: RevolutApiError | null = null;

  for (const apiVersion of apiVersions) {
    try {
      await revolutMerchantRequest<unknown>(
        environment,
        validation.normalized,
        endpoint,
        { method: "GET" },
        apiVersion,
      );
      return { endpoint_tested: REVOLUT_MERCHANT_COLLECTION_PROBE, api_version: apiVersion };
    } catch (err) {
      lastErr = err as RevolutApiError;
      if (lastErr.status !== 401 && lastErr.status !== 404) break;
    }
  }

  if (lastErr?.status === 401 && environment === "live") {
    try {
      await revolutMerchantRequest<unknown>(
        "test",
        validation.normalized,
        endpoint,
        { method: "GET" },
        "2024-05-01",
      );
      throw {
        message: "Secret key works on Revolut sandbox but provider is in Live mode. Switch to Test mode or paste the Production API Secret key.",
        status: 401,
        body: { code: "environment_mismatch" },
      } satisfies RevolutApiError;
    } catch (sandboxErr) {
      const sandbox = sandboxErr as RevolutApiError;
      if (sandbox.status === 0 || sandbox.message.includes("Secret key works on Revolut sandbox")) {
        throw sandbox;
      }
    }
  }

  if (lastErr) throw lastErr;

  throw {
    message: "Revolut Merchant API probe failed",
    status: 0,
    body: null,
  } satisfies RevolutApiError;
}

export function normalizeRevolutBusinessAccessToken(raw: string): string {
  let token = raw.trim();
  if (/^bearer\s+/i.test(token)) {
    token = token.replace(/^bearer\s+/i, "").trim();
  }
  return token;
}

export function explainRevolutBusinessAuthFailure(
  message: string,
  tokenUsed: string,
): string {
  const normalized = message.toLowerCase();
  if (/^sk_/i.test(tokenUsed) || normalized.includes("invalid api key")) {
    return "Driver payouts use the Revolut Business API (access token oa_prod_…), not the Merchant secret key (sk_…). In admin → Revolut → Edit secrets, add your Business API access token.";
  }
  return message;
}

/** Business API token for counterparties and /pay — separate from Merchant sk_ key. */
export async function resolveRevolutBusinessAccessToken(
  supabase: SupabaseClient,
  environment: ProviderEnvironment,
): Promise<string | null> {
  const { data } = await supabase
    .from("payment_provider_vault")
    .select("secret_value")
    .eq("provider", "revolut")
    .eq("environment", environment)
    .eq("secret_name", "business_access_token")
    .maybeSingle();

  const fromVault = (data?.secret_value as string | null)?.trim();
  if (fromVault && !fromVault.includes("•")) {
    return normalizeRevolutBusinessAccessToken(fromVault);
  }

  const envToken = Deno.env.get("REVOLUT_BUSINESS_ACCESS_TOKEN")?.trim();
  if (envToken) return normalizeRevolutBusinessAccessToken(envToken);

  return null;
}

export async function testRevolutBusinessConnection(
  environment: ProviderEnvironment,
  accessToken: string,
): Promise<{ endpoint_tested: string }> {
  const normalized = normalizeRevolutBusinessAccessToken(accessToken);
  if (/^sk_/i.test(normalized)) {
    throw {
      message: "Business API probe received a Merchant secret key (sk_…). Use a Business access token (oa_prod_…).",
      status: 0,
      body: { code: "merchant_key_in_business_slot" },
    } satisfies RevolutApiError;
  }
  await revolutBusinessRequest<unknown>(environment, normalized, "/accounts");
  return { endpoint_tested: "GET /api/1.0/accounts" };
}

export async function revolutBusinessRequest<T = Record<string, unknown>>(
  environment: ProviderEnvironment,
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const normalizedToken = normalizeRevolutBusinessAccessToken(accessToken);
  const res = await fetch(`${revolutBusinessBaseUrl(environment)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${normalizedToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await parseJsonSafe(res);
  if (!res.ok) {
    const parsed = parseRevolutErrorBody(body);
    const rawMessage = parsed.revolut_message
      ?? (typeof body === "object" && body && "message" in body
        ? String((body as { message?: string }).message)
        : `Revolut Business API error (${res.status})`);
    const message = explainRevolutBusinessAuthFailure(rawMessage, normalizedToken);
    throw { message, status: res.status, body } satisfies RevolutApiError;
  }
  return body as T;
}

export type RevolutAccount = {
  id: string;
  currency?: string;
  balance?: number;
  state?: string;
};

export type RevolutCounterparty = {
  id: string;
  name?: string;
};

export async function listRevolutAccounts(
  environment: ProviderEnvironment,
  accessToken: string,
): Promise<RevolutAccount[]> {
  const data = await revolutBusinessRequest<RevolutAccount[] | { accounts?: RevolutAccount[] }>(
    environment,
    accessToken,
    "/accounts",
  );
  if (Array.isArray(data)) return data;
  return data.accounts ?? [];
}

export async function createRevolutCounterparty(args: {
  environment: ProviderEnvironment;
  accessToken: string;
  destinationType: string;
  destinationIdentifier: string;
  accountHolderName: string | null;
  currencyCode: string;
}): Promise<RevolutCounterparty> {
  const currency = (args.currencyCode || "GBP").toUpperCase();
  const name = args.accountHolderName?.trim() || "Driver";
  const id = args.destinationIdentifier.trim();
  let body: Record<string, unknown>;

  if (args.destinationType === "revolut_account") {
    const revtag = id.startsWith("@") ? id.slice(1) : id;
    body = { profile_type: "personal", name, revtag };
  } else if (args.destinationType === "iban") {
    body = {
      profile_type: "personal",
      name,
      bank_country: id.slice(0, 2).toUpperCase(),
      currency,
      iban: id.replace(/\s/g, "").toUpperCase(),
    };
  } else if (args.destinationType === "uk_bank_account") {
    const digits = id.replace(/\D/g, "");
    body = {
      profile_type: "personal",
      name,
      bank_country: "GB",
      currency,
      accounts: [{
        account_no: digits.slice(6),
        sort_code: digits.slice(0, 6),
        currency,
        country: "GB",
      }],
    };
  } else {
    body = {
      profile_type: "personal",
      name,
      bank_country: "GB",
      currency,
      accounts: [{ account_no: id, currency, country: "GB" }],
    };
  }

  return await revolutBusinessRequest<RevolutCounterparty>(
    args.environment,
    args.accessToken,
    "/counterparty",
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function executeRevolutPay(args: {
  environment: ProviderEnvironment;
  accessToken: string;
  sourceAccountId: string;
  counterpartyId: string;
  amountPence: number;
  currencyCode: string;
  reference: string;
  requestId: string;
}): Promise<{ id: string; state?: string }> {
  const currency = args.currencyCode.toUpperCase();
  const body = {
    request_id: args.requestId,
    account_id: args.sourceAccountId,
    receiver: { counterparty_id: args.counterpartyId },
    amount: args.amountPence / 100,
    currency,
    reference: args.reference.slice(0, 140),
  };
  return await revolutBusinessRequest(
    args.environment,
    args.accessToken,
    "/pay",
    { method: "POST", body: JSON.stringify(body) },
  );
}

export type RevolutMerchantPayout = {
  id: string;
  state: string;
  amount: number;
  currency: string;
  scheduled_for?: string;
  completed_at?: string;
  reference?: string;
  [k: string]: unknown;
};

function merchantPayoutsBaseUrl(environment: ProviderEnvironment): string {
  return revolutMerchantBaseUrl(environment);
}

export async function listRevolutMerchantPayouts(args: {
  environment: ProviderEnvironment;
  secretKey: string;
  limit?: number;
  fromCreated?: string;
  toCreated?: string;
}): Promise<RevolutMerchantPayout[]> {
  const params = new URLSearchParams();
  if (args.limit) params.set("limit", String(args.limit));
  if (args.fromCreated) params.set("from_created", args.fromCreated);
  if (args.toCreated) params.set("to_created", args.toCreated);
  const qs = params.toString();
  const url = `${merchantPayoutsBaseUrl(args.environment)}/payouts${qs ? `?${qs}` : ""}`;
  const normalizedKey = normalizeRevolutMerchantSecret(args.secretKey);
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${normalizedKey}`,
      Accept: "application/json",
      "Revolut-Api-Version": "2026-04-20",
    },
  });
  const body = await parseJsonSafe(res);
  if (!res.ok) {
    const message = typeof body === "object" && body && "message" in body
      ? String((body as { message?: string }).message)
      : `Revolut Merchant payouts error (${res.status})`;
    throw { message, status: res.status, body } satisfies RevolutApiError;
  }
  if (Array.isArray(body)) return body as RevolutMerchantPayout[];
  if (body && typeof body === "object" && Array.isArray((body as { payouts?: unknown[] }).payouts)) {
    return (body as { payouts: RevolutMerchantPayout[] }).payouts;
  }
  return [];
}

export async function getRevolutMerchantPayout(args: {
  environment: ProviderEnvironment;
  secretKey: string;
  payoutId: string;
}): Promise<RevolutMerchantPayout> {
  const url = `${merchantPayoutsBaseUrl(args.environment)}/payouts/${encodeURIComponent(args.payoutId)}`;
  const normalizedKey = normalizeRevolutMerchantSecret(args.secretKey);
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${normalizedKey}`,
      Accept: "application/json",
      "Revolut-Api-Version": "2026-04-20",
    },
  });
  const body = await parseJsonSafe(res);
  if (!res.ok) {
    const message = typeof body === "object" && body && "message" in body
      ? String((body as { message?: string }).message)
      : `Revolut Merchant payout fetch error (${res.status})`;
    throw { message, status: res.status, body } satisfies RevolutApiError;
  }
  return body as RevolutMerchantPayout;
}

export type RevolutMerchantPayment = {
  id: string;
  order_id?: string;
  state?: string;
  status?: string;
  amount?: number;
  currency?: string;
  fee?: number;
  fees?: unknown;
  refunded_amount?: number;
  created_at?: string;
  updated_at?: string;
  payment_method?: unknown;
  card?: unknown;
  [k: string]: unknown;
};

export type OnecabPaymentReconciliation = {
  payment_id: string;
  order_id: string | null;
  state: string | null;
  amount_minor: number | null;
  currency: string | null;
  fee_minor: number | null;
  refunded_amount_minor: number | null;
  created_at: string | null;
  updated_at: string | null;
  payment_method: unknown;
  raw: RevolutMerchantPayment;
};

export async function getRevolutMerchantPayment(args: {
  environment: ProviderEnvironment;
  secretKey: string;
  paymentId: string;
}): Promise<RevolutMerchantPayment> {
  const normalizedKey = normalizeRevolutMerchantSecret(args.secretKey);
  const url = `${revolutMerchantBaseUrl(args.environment)}/payments/${encodeURIComponent(args.paymentId)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${normalizedKey}`,
      Accept: "application/json",
      "Revolut-Api-Version": "2026-04-20",
    },
  });
  const body = await parseJsonSafe(res);
  if (!res.ok) {
    const message = typeof body === "object" && body && "message" in body
      ? String((body as { message?: string }).message)
      : `Revolut Merchant payment fetch error (${res.status})`;
    throw { message, status: res.status, body } satisfies RevolutApiError;
  }
  return body as RevolutMerchantPayment;
}

export function mapRevolutPaymentToOnecab(p: RevolutMerchantPayment): OnecabPaymentReconciliation {
  const method = p.payment_method ?? p.card ?? null;
  return {
    payment_id: p.id,
    order_id: p.order_id ?? null,
    state: (p.state ?? p.status ?? null) as string | null,
    amount_minor: typeof p.amount === "number" ? p.amount : null,
    currency: p.currency ?? null,
    fee_minor: typeof p.fee === "number" ? p.fee : null,
    refunded_amount_minor: typeof p.refunded_amount === "number" ? p.refunded_amount : null,
    created_at: p.created_at ?? null,
    updated_at: p.updated_at ?? null,
    payment_method: method,
    raw: p,
  };
}
