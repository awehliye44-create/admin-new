/**
 * Company payee SSOT — beneficiaries for Company Transfers only.
 * Never returns full bank details after save. Never uses Driver Wallet.
 */

export const COMPANY_PAYEE_TYPES = [
  "STAFF",
  "DIRECTOR",
  "CONTRACTOR",
  "SUPPLIER",
  "EXPENSE_CLAIMANT",
  "OTHER",
] as const;

export type CompanyPayeeType = (typeof COMPANY_PAYEE_TYPES)[number];

export const COMPANY_PAYEE_VERIFICATION_STATUSES = [
  "UNVERIFIED",
  "PENDING",
  "VERIFIED",
  "FAILED",
  "REVOKED",
] as const;

export type CompanyPayeeVerificationStatus =
  (typeof COMPANY_PAYEE_VERIFICATION_STATUSES)[number];

/** Categories allowed for company transfers (extended). */
export const COMPANY_TRANSFER_CATEGORIES_V2 = [
  "STAFF_SALARY",
  "DIRECTOR_SALARY",
  "CONTRACTOR_PAYMENT",
  "SUPPLIER_PAYMENT",
  "EXPENSE_REIMBURSEMENT",
  "STAFF_REIMBURSEMENT",
  "TAX_PAYMENT",
  "REGULATORY_PAYMENT",
  "DIRECTOR_DIVIDEND",
  "DIRECTOR_LOAN",
  "COMPANY_WITHDRAWAL",
  "OTHER_APPROVED_PAYABLE",
  "OFFICE_EXPENSES",
  "SOFTWARE_SAAS",
  "MARKETING",
  "FLEET_EXPENSES",
  "INTERNAL_BANK_TRANSFER",
  "REFUND_RESERVE",
  "OTHER",
] as const;

export type CompanyTransferCategoryV2 = (typeof COMPANY_TRANSFER_CATEGORIES_V2)[number];

export const HIGH_RISK_COMPANY_TRANSFER_CATEGORIES = [
  "DIRECTOR_DIVIDEND",
  "DIRECTOR_LOAN",
  "COMPANY_WITHDRAWAL",
  "TAX_PAYMENT",
  "REGULATORY_PAYMENT",
] as const;

export const COMPANY_TRANSFER_STATUSES_V2 = [
  "DRAFT",
  "AWAITING_APPROVAL",
  "APPROVED",
  "SCHEDULED",
  "PROCESSING",
  "COMPLETED",
  "PAID",
  "FAILED",
  "DECLINED",
  "REJECTED",
  "REVERTED",
  "CANCELLED",
  "FUNDING_UNAVAILABLE",
] as const;

export type CompanyPayeePublicDto = {
  id: string;
  legal_name: string;
  display_name: string;
  payee_type: CompanyPayeeType | string;
  email: string | null;
  phone: string | null;
  currency: string;
  country: string;
  payment_purpose: string | null;
  default_reference: string | null;
  revolut_counterparty_id: string | null;
  revolut_recipient_account_id: string | null;
  account_holder_name: string | null;
  bank_name: string | null;
  masked_account: string;
  account_verification_status: CompanyPayeeVerificationStatus | string;
  active: boolean;
  paused: boolean;
  created_by: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
  /** Never include encrypted bank fields in public DTO. */
  sort_code_encrypted?: never;
  account_number_encrypted?: never;
  iban_encrypted?: never;
  account_fingerprint?: never;
};

export function isHighRiskCompanyTransferCategory(category: string | null | undefined): boolean {
  const c = String(category ?? "").toUpperCase();
  return (HIGH_RISK_COMPANY_TRANSFER_CATEGORIES as readonly string[]).includes(c);
}

export function maskUkAccount(args: {
  sort_code?: string | null;
  account_number?: string | null;
  iban?: string | null;
}): string {
  const iban = String(args.iban ?? "").replace(/\s/g, "").toUpperCase();
  if (iban.length >= 4) return `•••• ${iban.slice(-4)}`;
  const acct = String(args.account_number ?? "").replace(/\D/g, "");
  if (acct.length >= 4) return `•••• ${acct.slice(-4)}`;
  return "••••";
}

export function normaliseUkBankDigits(sortCode: string, accountNumber: string): {
  sort_code: string;
  account_number: string;
} {
  const sort_code = String(sortCode ?? "").replace(/\D/g, "");
  const account_number = String(accountNumber ?? "").replace(/\D/g, "");
  if (sort_code.length !== 6) throw new Error("INVALID_SORT_CODE");
  if (account_number.length < 6 || account_number.length > 10) throw new Error("INVALID_ACCOUNT_NUMBER");
  return { sort_code, account_number };
}

export function normaliseIban(iban: string): string {
  const v = String(iban ?? "").replace(/\s/g, "").toUpperCase();
  if (v.length < 15 || v.length > 34) throw new Error("INVALID_IBAN");
  return v;
}

/** Deterministic fingerprint for duplicate detection (not a secret). */
export async function companyPayeeAccountFingerprint(args: {
  currency: string;
  sort_code?: string | null;
  account_number?: string | null;
  iban?: string | null;
}): Promise<string> {
  const currency = String(args.currency ?? "GBP").toUpperCase();
  let material = "";
  if (args.iban) {
    material = `iban:${normaliseIban(args.iban)}`;
  } else {
    const uk = normaliseUkBankDigits(String(args.sort_code ?? ""), String(args.account_number ?? ""));
    material = `uk:${uk.sort_code}:${uk.account_number}`;
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${currency}|${material}`),
  );
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function assertPayeePayable(args: {
  active: boolean;
  paused: boolean;
  account_verification_status: string;
  revolut_counterparty_id?: string | null;
}): { ok: true } | { ok: false; status: string } {
  if (!args.active) return { ok: false, status: "PAYEE_INACTIVE" };
  if (args.paused) return { ok: false, status: "PAYEE_PAUSED" };
  if (String(args.account_verification_status).toUpperCase() !== "VERIFIED") {
    return { ok: false, status: "PAYEE_UNVERIFIED" };
  }
  if (!String(args.revolut_counterparty_id ?? "").trim()) {
    return { ok: false, status: "PAYEE_COUNTERPARTY_MISSING" };
  }
  return { ok: true };
}

export function toCompanyPayeePublicDto(row: Record<string, unknown>): CompanyPayeePublicDto {
  return {
    id: String(row.id),
    legal_name: String(row.legal_name ?? ""),
    display_name: String(row.display_name ?? ""),
    payee_type: String(row.payee_type ?? "OTHER"),
    email: row.email == null ? null : String(row.email),
    phone: row.phone == null ? null : String(row.phone),
    currency: String(row.currency ?? "GBP").toUpperCase(),
    country: String(row.country ?? "GB").toUpperCase(),
    payment_purpose: row.payment_purpose == null ? null : String(row.payment_purpose),
    default_reference: row.default_reference == null ? null : String(row.default_reference),
    revolut_counterparty_id: row.revolut_counterparty_id == null ? null : String(row.revolut_counterparty_id),
    revolut_recipient_account_id: row.revolut_recipient_account_id == null
      ? null
      : String(row.revolut_recipient_account_id),
    account_holder_name: row.account_holder_name == null ? null : String(row.account_holder_name),
    bank_name: row.bank_name == null ? null : String(row.bank_name),
    masked_account: String(row.masked_account ?? "••••"),
    account_verification_status: String(row.account_verification_status ?? "UNVERIFIED"),
    active: row.active !== false,
    paused: row.paused === true,
    created_by: row.created_by == null ? null : String(row.created_by),
    approved_by: row.approved_by == null ? null : String(row.approved_by),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

export function buildCompanyTransferRequestId(args: {
  company_transfer_id: string;
  execution_attempt: number;
}): string {
  return `ct:${args.company_transfer_id}:v${Math.max(1, Math.round(args.execution_attempt))}`;
}

export function assertNoStripeCompanyTransferFields(payload: Record<string, unknown>): void {
  const keys = Object.keys(payload).map((k) => k.toLowerCase());
  for (const k of keys) {
    if (k.includes("stripe")) throw new Error("STRIPE_FORBIDDEN_ON_COMPANY_TRANSFER");
  }
}
