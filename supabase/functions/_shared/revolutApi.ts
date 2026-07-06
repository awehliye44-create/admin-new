import type { ProviderEnvironment } from "./paymentProviders/types.ts";

export type RevolutApiError = {
  message: string;
  status: number;
  body?: unknown;
};

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
  const revolut_error_code = [
    record.code,
    record.error_code,
    record.errorCode,
    record.type,
  ].find((v) => typeof v === "string" && v.trim()) as string | undefined ?? null;
  return { revolut_message, revolut_error_code };
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
  const message = [
    `Revolut ${apiSurface} API: ${http_status} ${http_status_label}`,
    revolut_error_code ? `Code: ${revolut_error_code}` : null,
    revolut_message,
  ].filter(Boolean).join(" — ");
  return {
    message,
    http_status,
    http_status_label,
    revolut_error_code,
    revolut_message,
    api_surface,
  };
}

export async function testRevolutMerchantConnection(
  environment: ProviderEnvironment,
  secretKey: string,
): Promise<void> {
  await revolutMerchantRequest<unknown>(
    environment,
    secretKey,
    "/orders?limit=1",
  );
}

export function revolutBusinessBaseUrl(environment: ProviderEnvironment): string {
  return environment === "live"
    ? "https://b2b.revolut.com/api/1.0"
    : "https://sandbox-b2b.revolut.com/api/1.0";
}

export function revolutMerchantBaseUrl(environment: ProviderEnvironment): string {
  return environment === "live"
    ? "https://merchant.revolut.com/api/1.0"
    : "https://sandbox-merchant.revolut.com/api/1.0";
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

export async function revolutBusinessRequest<T = Record<string, unknown>>(
  environment: ProviderEnvironment,
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${revolutBusinessBaseUrl(environment)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await parseJsonSafe(res);
  if (!res.ok) {
    const message = typeof body === "object" && body && "message" in body
      ? String((body as { message?: string }).message)
      : `Revolut Business API error (${res.status})`;
    throw { message, status: res.status, body } satisfies RevolutApiError;
  }
  return body as T;
}

export async function revolutMerchantRequest<T = Record<string, unknown>>(
  environment: ProviderEnvironment,
  secretKey: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${revolutMerchantBaseUrl(environment)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Revolut-Api-Version": "2024-09-01",
      ...(init?.headers ?? {}),
    },
  });
  const body = await parseJsonSafe(res);
  if (!res.ok) {
    const message = typeof body === "object" && body && "message" in body
      ? String((body as { message?: string }).message)
      : `Revolut Merchant API error (${res.status})`;
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
    body = {
      profile_type: "personal",
      name,
      revtag,
    };
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
    const sortCode = digits.slice(0, 6);
    const accountNo = digits.slice(6);
    body = {
      profile_type: "personal",
      name,
      bank_country: "GB",
      currency,
      accounts: [{
        account_no: accountNo,
        sort_code: sortCode,
        currency,
        country: "GB",
      }],
    };
  } else {
    body = {
      profile_type: "personal",
      name,
      bank_country: currency === "GBP" ? "GB" : "GB",
      currency,
      accounts: [{
        account_no: id,
        currency,
        country: "GB",
      }],
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

// ---------------------------------------------------------------------------
// Merchant Payouts (settlement to the platform's bank / Revolut Business acc)
// Endpoint: GET https://merchant.revolut.com/api/payouts
// Docs: https://developer.revolut.com/docs/merchant/list-payouts
// Version header pinned to 2026-04-20 per project spec.
// ---------------------------------------------------------------------------
export type RevolutMerchantPayout = {
  id: string;
  state: string;
  amount: number;        // integer minor units
  currency: string;
  scheduled_for?: string;
  completed_at?: string;
  reference?: string;
  [k: string]: unknown;
};

function merchantPayoutsBaseUrl(environment: ProviderEnvironment): string {
  return environment === "live"
    ? "https://merchant.revolut.com/api"
    : "https://sandbox-merchant.revolut.com/api";
}

export async function listRevolutMerchantPayouts(args: {
  environment: ProviderEnvironment;
  secretKey: string;
  limit?: number;
  fromCreated?: string;   // ISO-8601
  toCreated?: string;
}): Promise<RevolutMerchantPayout[]> {
  const params = new URLSearchParams();
  if (args.limit) params.set("limit", String(args.limit));
  if (args.fromCreated) params.set("from_created", args.fromCreated);
  if (args.toCreated) params.set("to_created", args.toCreated);
  const qs = params.toString();
  const url = `${merchantPayoutsBaseUrl(args.environment)}/payouts${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${args.secretKey}`,
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
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${args.secretKey}`,
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

// ---------------------------------------------------------------------------
// Merchant Payment details
// GET https://merchant.revolut.com/api/1.0/payments/{payment_id}
// Version header pinned to 2026-04-20 per project spec.
// ---------------------------------------------------------------------------
export type RevolutMerchantPayment = {
  id: string;
  order_id?: string;
  state?: string;
  status?: string;
  amount?: number;              // integer minor units
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
  const url = `${revolutMerchantBaseUrl(args.environment)}/payments/${encodeURIComponent(args.paymentId)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${args.secretKey}`,
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


