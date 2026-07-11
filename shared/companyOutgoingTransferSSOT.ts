/**
 * Company outgoing transfer SSOT — money source + categories.
 * Hard rule: never DRIVER_WALLET / PAYMENT_SESSIONS / pending captures.
 */

export const COMPANY_TRANSFER_MONEY_SOURCES = [
  "COMPANY_BALANCE",
  "APPROVED_COMPANY_PAYABLE",
] as const;

export type CompanyTransferMoneySource = (typeof COMPANY_TRANSFER_MONEY_SOURCES)[number];

export const FORBIDDEN_COMPANY_TRANSFER_SOURCES = [
  "DRIVER_WALLET",
  "DRIVER_WALLET_AVAILABLE",
  "PAYMENT_SESSION",
  "PAYMENT_SESSIONS",
  "PENDING_CUSTOMER_CAPTURE",
  "CUSTOMER_AUTHORISATION",
] as const;

export const COMPANY_TRANSFER_CATEGORIES = [
  "STAFF_SALARY",
  "STAFF_REIMBURSEMENT",
  "SUPPLIER_PAYMENT",
  "CONTRACTOR_PAYMENT",
  "TAX_PAYMENT",
  "OFFICE_EXPENSES",
  "SOFTWARE_SAAS",
  "MARKETING",
  "FLEET_EXPENSES",
  "INTERNAL_BANK_TRANSFER",
  "REFUND_RESERVE",
  "OTHER",
] as const;

export type CompanyTransferCategory = (typeof COMPANY_TRANSFER_CATEGORIES)[number];

export const COMPANY_TRANSFER_RECIPIENT_TYPES = [
  "STAFF",
  "SUPPLIER",
  "CONTRACTOR",
  "TAX_AUTHORITY",
  "INTERNAL",
  "OTHER",
] as const;

export type CompanyTransferRecipientType = (typeof COMPANY_TRANSFER_RECIPIENT_TYPES)[number];

export function isAllowedCompanyTransferMoneySource(raw: string | null | undefined): boolean {
  const v = String(raw ?? "").trim().toUpperCase();
  return (COMPANY_TRANSFER_MONEY_SOURCES as readonly string[]).includes(v);
}

export function assertCompanyTransferMoneySource(raw: string | null | undefined): CompanyTransferMoneySource {
  const v = String(raw ?? "").trim().toUpperCase();
  if ((FORBIDDEN_COMPANY_TRANSFER_SOURCES as readonly string[]).includes(v)) {
    throw new Error(`FORBIDDEN_MONEY_SOURCE:${v}`);
  }
  if (!isAllowedCompanyTransferMoneySource(v)) {
    throw new Error(`INVALID_MONEY_SOURCE:${v || "EMPTY"}`);
  }
  return v as CompanyTransferMoneySource;
}

/** Staff reimbursements must use company balance / payables only. */
export function resolveDefaultMoneySourceForCategory(
  category: string | null | undefined,
): CompanyTransferMoneySource {
  const c = String(category ?? "").toUpperCase();
  if (c === "STAFF_REIMBURSEMENT" || c === "STAFF_SALARY") return "COMPANY_BALANCE";
  return "COMPANY_BALANCE";
}

export function isCompanyTransferCategory(raw: string | null | undefined): boolean {
  return (COMPANY_TRANSFER_CATEGORIES as readonly string[]).includes(String(raw ?? "").toUpperCase());
}
