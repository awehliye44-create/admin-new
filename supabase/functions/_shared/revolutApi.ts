import type { ProviderEnvironment } from "./paymentProviders/types.ts";

export type RevolutApiError = {
  message: string;
  status: number;
  body?: unknown;
};

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

