/**
 * A8B28F-B2R — UK driver Revolut counterparty payload builder (live).
 *
 * Aligns with company-payee SSOT + Revolut Business UK local bank contract:
 * - business holders → company_name + flat account_no/sort_code
 * - personal holders → individual_name { first_name, last_name }
 *
 * Used by createRevolutCounterparty for destinationType=uk_bank_account.
 * Does not call Revolut; pure payload construction only.
 */

export type UkDriverCounterpartyKind = "business" | "personal";

export function normalizeUkAccountHolderName(name: string): string {
  return String(name ?? "").trim().replace(/\s+/g, " ");
}

export function digitsOnly(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D/g, "");
}

/** Detect UK company-style legal names (Limited / Ltd / PLC / LLP / …). */
export function detectUkDriverCounterpartyKind(
  accountHolderName: string | null | undefined,
): UkDriverCounterpartyKind {
  const n = normalizeUkAccountHolderName(accountHolderName ?? "");
  if (
    /\b(limited|ltd\.?|plc|llp|inc\.?|corp\.?|corporation|llc)\b/i.test(n)
  ) {
    return "business";
  }
  return "personal";
}

export function splitIndividualName(fullName: string): {
  first_name: string;
  last_name: string;
} {
  const normalized = normalizeUkAccountHolderName(fullName);
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
 * Revolut UK bank counterparty create body.
 * destinationIdentifier = sort(6) + account(8–10) digits, or separate fields.
 */
export function buildUkDriverRevolutCounterpartyBody(args: {
  accountHolderName: string | null | undefined;
  destinationIdentifier?: string | null;
  sortCode?: string | null;
  accountNumber?: string | null;
  currency?: string;
  bankCountry?: string;
  /** Override auto-detect when known. */
  kind?: UkDriverCounterpartyKind;
}): Record<string, unknown> {
  const currency = (args.currency ?? "GBP").toUpperCase();
  const bank_country = (args.bankCountry ?? "GB").toUpperCase();
  let sort_code = digitsOnly(args.sortCode);
  let account_no = digitsOnly(args.accountNumber);
  if ((!sort_code || !account_no) && args.destinationIdentifier) {
    const digits = digitsOnly(args.destinationIdentifier);
    sort_code = digits.slice(0, 6);
    account_no = digits.slice(6);
  }
  const holder = normalizeUkAccountHolderName(args.accountHolderName ?? "");
  const kind = args.kind ?? detectUkDriverCounterpartyKind(holder);
  const body: Record<string, unknown> = {
    bank_country,
    currency,
    account_no,
    sort_code,
  };
  if (kind === "business") {
    body.company_name = holder || "Company";
  } else {
    body.individual_name = splitIndividualName(holder || "Account Holder");
  }
  return body;
}
