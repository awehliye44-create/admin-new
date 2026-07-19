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

/**
 * Enforce money source by category.
 * Staff salary/reimbursement must always be COMPANY_BALANCE (never payables / wallet).
 */
export function resolveEnforcedCompanyTransferMoneySource(args: {
  category: string | null | undefined;
  money_source?: string | null;
}): CompanyTransferMoneySource {
  const category = String(args.category ?? "").toUpperCase();
  const requested = args.money_source == null || String(args.money_source).trim() === ""
    ? resolveDefaultMoneySourceForCategory(category)
    : assertCompanyTransferMoneySource(args.money_source);
  if (category === "STAFF_REIMBURSEMENT" || category === "STAFF_SALARY") {
    if (requested !== "COMPANY_BALANCE") {
      throw new Error("STAFF_MUST_USE_COMPANY_BALANCE");
    }
    return "COMPANY_BALANCE";
  }
  return requested;
}

export function isCompanyTransferCategory(raw: string | null | undefined): boolean {
  return (COMPANY_TRANSFER_CATEGORIES as readonly string[]).includes(String(raw ?? "").toUpperCase());
}

/** First-class transfer kinds for create UI (maps onto as_draft / execution_mode / scheduled_at). */
export const COMPANY_TRANSFER_KINDS = [
  "ONE_OFF",
  "SCHEDULED",
  "RECURRING",
  "CERTIFICATION",
] as const;

export type CompanyTransferKind = (typeof COMPANY_TRANSFER_KINDS)[number];

export const COMPANY_TRANSFER_KIND_LABELS: Record<CompanyTransferKind, string> = {
  ONE_OFF: "One-off transfer",
  SCHEDULED: "Scheduled transfer",
  RECURRING: "Recurring payment",
  CERTIFICATION: "Certification (£0.01 proof)",
};

export const COMPANY_TRANSFER_START_MODES = [
  "DRAFT",
  "APPROVAL_REQUIRED",
  "IMMEDIATE",
] as const;

export type CompanyTransferStartMode = (typeof COMPANY_TRANSFER_START_MODES)[number];

export const COMPANY_TRANSFER_START_MODE_LABELS: Record<CompanyTransferStartMode, string> = {
  DRAFT: "Draft",
  APPROVAL_REQUIRED: "Approval required",
  IMMEDIATE: "Immediate payment",
};

/**
 * Map UI kind + start mode → create payload fields.
 * Recurring is handled in UI via Automatic Payments (returns null create fields).
 * Immediate still creates workflow row; live /pay stays gated by LIVE_COMPANY_TRANSFER.
 */
export function resolveCompanyTransferCreateOptions(args: {
  kind: CompanyTransferKind | string;
  start_mode: CompanyTransferStartMode | string;
  scheduled_at?: string | null;
}): {
  ok: true;
  as_draft: boolean;
  execution_mode: "DRAFT_FOR_APPROVAL" | "DIRECT_TRANSFER";
  scheduled_at: string | null;
  use_recurring_schedule_ui: boolean;
} | { ok: false; error: string } {
  const kind = String(args.kind ?? "ONE_OFF").toUpperCase() as CompanyTransferKind;
  const start = String(args.start_mode ?? "DRAFT").toUpperCase() as CompanyTransferStartMode;
  if (kind === "RECURRING") {
    return {
      ok: true,
      as_draft: true,
      execution_mode: "DRAFT_FOR_APPROVAL",
      scheduled_at: null,
      use_recurring_schedule_ui: true,
    };
  }
  if (kind === "SCHEDULED") {
    const when = args.scheduled_at ? String(args.scheduled_at).trim() : "";
    if (!when) return { ok: false, error: "Scheduled transfer requires a date/time" };
  }
  // CERTIFICATION behaves like ONE_OFF draft; transfer_type is set by create payload.
  const as_draft = start === "DRAFT" || kind === "CERTIFICATION";
  const execution_mode =
    start === "IMMEDIATE" && kind !== "CERTIFICATION"
      ? "DIRECT_TRANSFER"
      : "DRAFT_FOR_APPROVAL";
  return {
    ok: true,
    as_draft,
    execution_mode,
    scheduled_at: kind === "SCHEDULED" && args.scheduled_at
      ? new Date(args.scheduled_at).toISOString()
      : null,
    use_recurring_schedule_ui: false,
  };
}

/** In-flight statuses that should auto-poll provider status. */
export const COMPANY_TRANSFER_RECONCILE_STATUSES = new Set([
  "SUBMITTING",
  "PROCESSING",
  "QUEUED",
  "READY_FOR_EXECUTION",
  "SCHEDULED",
]);
