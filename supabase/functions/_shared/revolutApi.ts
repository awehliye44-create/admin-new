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
