/**
 * Company payee ↔ Revolut Business counterparty link SSOT.
 * Linkage only — never /pay, never company debit, never driver wallet.
 *
 * Display statuses (UI SSOT):
 *   UNVERIFIED → local bank details saved, no provider link
 *   LINKING → provider request in progress (DB: PENDING)
 *   PROVIDER_VERIFIED → Revolut confirms linked recipient (DB: VERIFIED)
 *   LINK_FAILED → exact provider/backend reason stored (DB: FAILED)
 */

export const COMPANY_PAYEE_LINK_DISPLAY = {
  UNVERIFIED: "UNVERIFIED",
  LINKING: "LINKING",
  PROVIDER_VERIFIED: "PROVIDER_VERIFIED",
  LINK_FAILED: "LINK_FAILED",
  REVOKED: "REVOKED",
} as const;

export type CompanyPayeeLinkDisplayStatus =
  (typeof COMPANY_PAYEE_LINK_DISPLAY)[keyof typeof COMPANY_PAYEE_LINK_DISPLAY];

/** Persistable DB values (CHECK constraint on company_payees). */
export const COMPANY_PAYEE_LINK_DB = {
  UNVERIFIED: "UNVERIFIED",
  PENDING: "PENDING",
  VERIFIED: "VERIFIED",
  FAILED: "FAILED",
  REVOKED: "REVOKED",
} as const;

export const COMPANY_PAYEE_LINK_ERROR = {
  AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
  BANK_DETAILS_MISSING: "BANK_DETAILS_MISSING",
  BANK_DETAILS_INCOMPLETE: "BANK_DETAILS_INCOMPLETE",
  DECRYPT_FAILED: "DECRYPT_FAILED",
  RELAY_UNAVAILABLE: "RELAY_UNAVAILABLE",
  COUNTERPARTY_MATCH_CONFLICT: "COUNTERPARTY_MATCH_CONFLICT",
  COUNTERPARTY_CREATE_FAILED: "COUNTERPARTY_CREATE_FAILED",
  PROVIDER_RESPONSE_INVALID: "PROVIDER_RESPONSE_INVALID",
  PROVIDER_REJECTED: "PROVIDER_REJECTED",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  DUPLICATE_REQUIRES_RECONCILIATION: "DUPLICATE_REQUIRES_RECONCILIATION",
} as const;

export type CompanyPayeeLinkErrorCode =
  (typeof COMPANY_PAYEE_LINK_ERROR)[keyof typeof COMPANY_PAYEE_LINK_ERROR];

export const COMPANY_PAYEE_LINK_ERROR_LABELS: Record<string, string> = {
  AUTHENTICATION_REQUIRED: "Revolut connection expired.",
  TOKEN_EXPIRED: "Revolut connection expired.",
  BANK_DETAILS_MISSING: "Payee bank details are incomplete.",
  BANK_DETAILS_INCOMPLETE: "Payee bank details are incomplete.",
  DECRYPT_FAILED: "Payee bank details are incomplete.",
  RELAY_UNAVAILABLE: "Provider linking is temporarily unavailable.",
  COUNTERPARTY_MATCH_CONFLICT:
    "Matching counterparty already exists and requires reconciliation.",
  DUPLICATE_REQUIRES_RECONCILIATION:
    "Matching counterparty already exists and requires reconciliation.",
  COUNTERPARTY_CREATE_FAILED: "Revolut rejected the account details.",
  PROVIDER_REJECTED: "Revolut rejected the account details.",
  PROVIDER_RESPONSE_INVALID: "Provider linking is temporarily unavailable.",
};

export function companyPayeeLinkErrorLabel(
  code: string | null | undefined,
  fallbackMessage?: string | null,
): string {
  const c = String(code ?? "").trim().toUpperCase();
  if (c && COMPANY_PAYEE_LINK_ERROR_LABELS[c]) return COMPANY_PAYEE_LINK_ERROR_LABELS[c];
  const msg = String(fallbackMessage ?? "").trim();
  if (/IP address is not whitelisted/i.test(msg)) {
    return "Provider linking is temporarily unavailable.";
  }
  if (/token|expired|unauthoriz|unauthoriz|oauth|authentication/i.test(msg)) {
    return "Revolut connection expired.";
  }
  if (/reject|invalid|validation|sort.?code|account/i.test(msg)) {
    return "Revolut rejected the account details.";
  }
  if (msg) return msg.slice(0, 180);
  return "Provider linking is temporarily unavailable.";
}

/** Map DB verification status → UI display status. */
export function companyPayeeVerificationDisplayStatus(
  dbStatus: string | null | undefined,
): CompanyPayeeLinkDisplayStatus {
  const s = String(dbStatus ?? "UNVERIFIED").toUpperCase();
  if (s === "VERIFIED" || s === "PROVIDER_VERIFIED") {
    return COMPANY_PAYEE_LINK_DISPLAY.PROVIDER_VERIFIED;
  }
  if (s === "PENDING" || s === "LINKING") return COMPANY_PAYEE_LINK_DISPLAY.LINKING;
  if (s === "FAILED" || s === "LINK_FAILED") return COMPANY_PAYEE_LINK_DISPLAY.LINK_FAILED;
  if (s === "REVOKED") return COMPANY_PAYEE_LINK_DISPLAY.REVOKED;
  return COMPANY_PAYEE_LINK_DISPLAY.UNVERIFIED;
}

export function isCompanyPayeeProviderVerified(
  dbStatus: string | null | undefined,
): boolean {
  const s = String(dbStatus ?? "").toUpperCase();
  return s === "VERIFIED" || s === "PROVIDER_VERIFIED";
}

export function companyPayeeLinkIdempotencyKey(payeeId: string): string {
  return `company-payee-cp:${String(payeeId).trim()}`;
}

export function normalizeAccountHolderName(name: string): string {
  return String(name ?? "").trim().replace(/\s+/g, " ");
}

export function digitsOnly(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D/g, "");
}

export function splitIndividualName(fullName: string): {
  first_name: string;
  last_name: string;
} {
  const normalized = normalizeAccountHolderName(fullName);
  if (!normalized) return { first_name: "Account", last_name: "Holder" };
  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length === 1) {
    return { first_name: parts[0].slice(0, 40), last_name: parts[0].slice(0, 40) };
  }
  return {
    first_name: parts[0].slice(0, 40),
    last_name: parts.slice(1).join(" ").slice(0, 40),
  };
}

/**
 * Revolut Business UK bank create body.
 * Company / director legal entities use company_name; individuals use individual_name.
 */
export function buildCompanyPayeeUkBankCounterpartyBody(args: {
  kind: "business" | "personal";
  accountHolderName: string;
  sortCode: string;
  accountNumber: string;
  currency?: string;
  bankCountry?: string;
}): Record<string, unknown> {
  const currency = (args.currency ?? "GBP").toUpperCase();
  const bank_country = (args.bankCountry ?? "GB").toUpperCase();
  const sort_code = digitsOnly(args.sortCode);
  const account_no = digitsOnly(args.accountNumber);
  const holder = normalizeAccountHolderName(args.accountHolderName);
  const body: Record<string, unknown> = {
    bank_country,
    currency,
    account_no,
    sort_code,
  };
  if (args.kind === "business") {
    body.company_name = holder || "Company";
  } else {
    body.individual_name = splitIndividualName(holder || "Account Holder");
  }
  return body;
}

/** Prefer business counterparty for company/director/supplier-style payees. */
export function companyPayeeCounterpartyKind(
  payeeType: string | null | undefined,
): "business" | "personal" {
  const t = String(payeeType ?? "").toUpperCase();
  if (
    t === "DIRECTOR"
    || t === "SUPPLIER"
    || t === "VEHICLE_SUPPLIER"
    || t === "SOFTWARE_SUBSCRIPTION"
    || t === "INSURANCE"
    || t === "HMRC_TAX"
    || t === "OFFICE_EXPENSE"
  ) {
    return "business";
  }
  return "personal";
}

export function ukBankDetailsMatch(args: {
  sortCode: string;
  accountNumber: string;
  candidateSortCode: string | null | undefined;
  candidateAccountNumber: string | null | undefined;
}): boolean {
  const sort = digitsOnly(args.sortCode);
  const acct = digitsOnly(args.accountNumber);
  const candSort = digitsOnly(args.candidateSortCode);
  const candAcct = digitsOnly(args.candidateAccountNumber);
  if (sort.length !== 6 || acct.length < 8 || candSort.length !== 6 || candAcct.length < 8) {
    return false;
  }
  return sort === candSort && acct === candAcct;
}

export type RevolutCounterpartyAccountLike = {
  id?: unknown;
  account_no?: unknown;
  account_number?: unknown;
  sort_code?: unknown;
  currency?: unknown;
};

export type RevolutCounterpartyLike = {
  id?: unknown;
  name?: unknown;
  accounts?: RevolutCounterpartyAccountLike[] | null;
};

export type CounterpartyMatchHit = {
  counterparty_id: string;
  recipient_account_id: string;
};

export function matchUkBankAgainstCounterparties(args: {
  sortCode: string;
  accountNumber: string;
  counterparties: RevolutCounterpartyLike[];
}): { status: "none" | "unique" | "conflict"; hit: CounterpartyMatchHit | null; hit_count: number } {
  const hits: CounterpartyMatchHit[] = [];
  for (const cp of args.counterparties) {
    const cpId = String(cp?.id ?? "").trim();
    if (!cpId) continue;
    const accounts = Array.isArray(cp.accounts) ? cp.accounts : [];
    for (const acct of accounts) {
      const acctId = String(acct?.id ?? "").trim();
      if (!acctId) continue;
      const currency = String(acct?.currency ?? "GBP").toUpperCase();
      if (currency && currency !== "GBP") continue;
      const candSort = String(acct?.sort_code ?? "");
      const candAcct = String(acct?.account_no ?? acct?.account_number ?? "");
      if (
        ukBankDetailsMatch({
          sortCode: args.sortCode,
          accountNumber: args.accountNumber,
          candidateSortCode: candSort,
          candidateAccountNumber: candAcct,
        })
      ) {
        hits.push({ counterparty_id: cpId, recipient_account_id: acctId });
      }
    }
  }
  const uniqueKeys = new Set(hits.map((h) => `${h.counterparty_id}:${h.recipient_account_id}`));
  if (uniqueKeys.size === 0) return { status: "none", hit: null, hit_count: 0 };
  if (uniqueKeys.size > 1) return { status: "conflict", hit: null, hit_count: uniqueKeys.size };
  return { status: "unique", hit: hits[0], hit_count: 1 };
}

export function pickRecipientAccountIdFromCreate(
  created: RevolutCounterpartyLike | null,
  sortCode: string,
  accountNumber: string,
): string | null {
  if (!created) return null;
  const accounts = Array.isArray(created.accounts) ? created.accounts : [];
  let fallback = "";
  for (const acct of accounts) {
    const aid = String(acct?.id ?? "").trim();
    if (!aid) continue;
    const candSort = String(acct?.sort_code ?? "");
    const candAcct = String(acct?.account_no ?? acct?.account_number ?? "");
    if (
      ukBankDetailsMatch({
        sortCode,
        accountNumber,
        candidateSortCode: candSort,
        candidateAccountNumber: candAcct,
      })
    ) {
      return aid;
    }
    if (!fallback) fallback = aid;
  }
  return fallback || null;
}

export function classifyProviderCreateFailure(args: {
  httpStatus: number;
  safeMessage: string;
}): { error_code: string; user_message: string } {
  const msg = args.safeMessage;
  if (args.httpStatus === 401 || /token|expired|unauthoriz|oauth/i.test(msg)) {
    return {
      error_code: COMPANY_PAYEE_LINK_ERROR.TOKEN_EXPIRED,
      user_message: companyPayeeLinkErrorLabel(COMPANY_PAYEE_LINK_ERROR.TOKEN_EXPIRED),
    };
  }
  if (/already exists|duplicate/i.test(msg)) {
    return {
      error_code: COMPANY_PAYEE_LINK_ERROR.DUPLICATE_REQUIRES_RECONCILIATION,
      user_message: companyPayeeLinkErrorLabel(
        COMPANY_PAYEE_LINK_ERROR.DUPLICATE_REQUIRES_RECONCILIATION,
      ),
    };
  }
  if (args.httpStatus === 400 || /reject|invalid|validation/i.test(msg)) {
    return {
      error_code: COMPANY_PAYEE_LINK_ERROR.PROVIDER_REJECTED,
      user_message: companyPayeeLinkErrorLabel(COMPANY_PAYEE_LINK_ERROR.PROVIDER_REJECTED, msg),
    };
  }
  return {
    error_code: COMPANY_PAYEE_LINK_ERROR.COUNTERPARTY_CREATE_FAILED,
    user_message: companyPayeeLinkErrorLabel(
      COMPANY_PAYEE_LINK_ERROR.COUNTERPARTY_CREATE_FAILED,
      msg,
    ),
  };
}
