/**
 * Company Transfer create-draft form UX SSOT.
 * Field markers, helper copy, validation, certification defaults.
 * Never moves money — draft creation only.
 */

/** Live GBP display under pence inputs. */
export function formatCompanyTransferPenceAsGbp(penceRaw: string | number | null | undefined): string | null {
  const n = typeof penceRaw === "number" ? penceRaw : Number(String(penceRaw ?? "").trim());
  if (!Number.isFinite(n) || String(penceRaw ?? "").trim() === "") return null;
  const pence = Math.round(n);
  const pounds = pence / 100;
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(pounds);
}

/** Warn when draft amount looks unusually large for manual entry (pence). */
export const COMPANY_TRANSFER_LARGE_AMOUNT_WARN_PENCE = 250_00; // £250

export function isUnusuallyLargeCompanyTransferAmount(pence: number): boolean {
  return Number.isFinite(pence) && pence >= COMPANY_TRANSFER_LARGE_AMOUNT_WARN_PENCE;
}

export const COMPANY_TRANSFER_FORM_FIELD_HELP = {
  saved_payee:
    "Select a verified saved payee. The recipient must be linked to Revolut before the transfer can be submitted.",
  category:
    "Choose the business purpose of this payment, such as Director Salary, Staff Salary, Supplier, Office Expense or Tax.",
  money_source:
    "Company Balance is the only permitted funding source. Driver Wallet and customer payments are never used.",
  source_account:
    "Automatically selected from the configured company funding account.",
  destination:
    "Masked recipient account. Full bank details remain encrypted and are never shown.",
  amount_pence:
    "Enter the amount in pence. Example: 1 = £0.01, 100 = £1.00.",
  approved_amount:
    "Leave blank to use the requested amount. Complete only when an approver changes the amount.",
  payment_reference:
    "This reference will appear in Revolut and the recipient’s bank statement. Example: ONECAB CERT 001",
  scheduled_at:
    "Optional. Leave blank for an immediate transfer after approval.",
  scheduled_at_required:
    "Required for scheduled transfers. Choose when this payment should run after approval.",
  currency:
    "Must match the payee and company funding account currency.",
  service_area:
    "Select the ONECAB service area responsible for this payment.",
  cost_centre:
    "Optional internal reporting code, such as ADMIN, OPERATIONS or MARKETING.",
  provider:
    "Payment provider used to execute the transfer. Revolut Business is currently configured.",
  attachment_url:
    "Optional link to an invoice, contract, receipt or supporting document.",
  purpose:
    "Briefly explain why this payment is being made. Example: £0.01 company transfer certification to verify the Revolut payout workflow.",
  notes:
    "Optional internal notes. Not sent to the recipient bank statement.",
  transfer_kind:
    "One-off for normal payments, Scheduled when a future date is required, or Certification for £0.01 proof drafts.",
  start_mode:
    "Draft for approval is the safe default. Immediate still cannot move money while company LIVE is off.",
} as const;

export type CompanyTransferFormFieldKey = keyof typeof COMPANY_TRANSFER_FORM_FIELD_HELP;

export const COMPANY_TRANSFER_CERTIFICATION_DEFAULTS = {
  transfer_kind: "CERTIFICATION",
  start_mode: "DRAFT",
  category: "DIRECTOR_SALARY",
  amount_pence: "1",
  payment_reference: "ONECAB CERT 001",
  currency: "GBP",
  provider: "revolut_business",
  purpose: "£0.01 company transfer certification.",
  money_source: "COMPANY_BALANCE",
} as const;

export type CompanyTransferDraftFormValues = {
  payee_id: string;
  recipient_name: string;
  category: string;
  money_source: string;
  source_account: string;
  destination_account: string;
  amount_pence: string;
  approved_amount_pence: string;
  payment_reference: string;
  scheduled_at: string;
  currency: string;
  service_area_id: string;
  cost_centre: string;
  provider: string;
  attachment_url: string;
  purpose: string;
  notes: string;
  transfer_kind: string;
  start_mode: string;
};

export type CompanyTransferDraftFieldError = {
  field: string;
  message: string;
};

export type CompanyTransferDraftValidation = {
  ok: boolean;
  errors: CompanyTransferDraftFieldError[];
  byField: Record<string, string>;
  amount_pence: number | null;
  gbp_display: string | null;
  large_amount_warning: boolean;
};

export function validateCompanyTransferDraftForm(args: {
  form: CompanyTransferDraftFormValues;
  payee_provider_verified: boolean;
  payee_currency?: string | null;
  context_service_area_id?: string | null;
  require_separate_approved_amount?: boolean;
}): CompanyTransferDraftValidation {
  const errors: CompanyTransferDraftFieldError[] = [];
  const f = args.form;
  const kind = String(f.transfer_kind ?? "ONE_OFF").toUpperCase();
  const isScheduled = kind === "SCHEDULED";

  if (!String(f.payee_id ?? "").trim()) {
    errors.push({ field: "payee_id", message: "Select a saved payee." });
  } else if (!args.payee_provider_verified) {
    errors.push({
      field: "payee_id",
      message: "Recipient must be linked to Revolut before the transfer can be submitted. Link the payee first, or create a draft only after provider verification.",
    });
  }

  if (!String(f.category ?? "").trim()) {
    errors.push({ field: "category", message: "Category is required." });
  }

  const amountRaw = String(f.amount_pence ?? "").trim();
  const amountPence = Math.round(Number(amountRaw));
  if (!amountRaw || !Number.isFinite(amountPence) || amountPence <= 0) {
    errors.push({
      field: "amount_pence",
      message: "Requested amount must be a positive number of pence (example: 1 = £0.01).",
    });
  }

  if (args.require_separate_approved_amount) {
    const approvedRaw = String(f.approved_amount_pence ?? "").trim();
    const approved = Math.round(Number(approvedRaw));
    if (!approvedRaw || !Number.isFinite(approved) || approved <= 0) {
      errors.push({
        field: "approved_amount_pence",
        message: "Approved amount is required by approval policy.",
      });
    }
  }

  if (!String(f.payment_reference ?? "").trim()) {
    errors.push({
      field: "payment_reference",
      message: "Payment reference is required (example: ONECAB CERT 001).",
    });
  }

  const currency = String(f.currency ?? "").trim().toUpperCase();
  if (!currency) {
    errors.push({ field: "currency", message: "Currency is required." });
  } else if (args.payee_currency && String(args.payee_currency).toUpperCase() !== currency) {
    errors.push({
      field: "currency",
      message: `Currency must match the payee (${String(args.payee_currency).toUpperCase()}).`,
    });
  }

  const serviceArea = String(f.service_area_id || args.context_service_area_id || "").trim();
  if (!serviceArea) {
    errors.push({ field: "service_area_id", message: "Service area is required." });
  }

  if (!String(f.provider ?? "").trim()) {
    errors.push({ field: "provider", message: "Provider is required." });
  } else if (!/revolut/i.test(String(f.provider))) {
    errors.push({
      field: "provider",
      message: "Provider unavailable. Revolut Business is currently configured.",
    });
  }

  if (!String(f.purpose ?? "").trim()) {
    errors.push({ field: "purpose", message: "Purpose is required." });
  }

  if (isScheduled && !String(f.scheduled_at ?? "").trim()) {
    errors.push({
      field: "scheduled_at",
      message: "Scheduled date/time is required for scheduled transfers.",
    });
  }

  const byField: Record<string, string> = {};
  for (const e of errors) {
    if (!byField[e.field]) byField[e.field] = e.message;
  }

  const gbp = Number.isFinite(amountPence) && amountPence > 0
    ? formatCompanyTransferPenceAsGbp(amountPence)
    : null;

  return {
    ok: errors.length === 0,
    errors,
    byField,
    amount_pence: Number.isFinite(amountPence) && amountPence > 0 ? amountPence : null,
    gbp_display: gbp,
    large_amount_warning: Number.isFinite(amountPence) && isUnusuallyLargeCompanyTransferAmount(amountPence),
  };
}

export function buildCompanyTransferDraftSummary(args: {
  recipient_name: string;
  masked_account: string;
  category: string;
  amount_pence: number | null;
  payment_reference: string;
  money_source: string;
  provider: string;
  service_area_name: string;
  is_certification: boolean;
}): {
  lines: Array<{ label: string; value: string }>;
  execution_note: string;
} {
  const amount = args.amount_pence != null
    ? formatCompanyTransferPenceAsGbp(args.amount_pence) ?? `${args.amount_pence} pence`
    : "—";
  const recipient = [args.recipient_name, args.masked_account].filter(Boolean).join(" ");
  return {
    lines: [
      { label: "Recipient", value: recipient || "—" },
      {
        label: "Category",
        value: args.is_certification
          ? `${args.category || "—"} (certification)`
          : (args.category || "—"),
      },
      { label: "Amount", value: amount },
      { label: "Reference", value: args.payment_reference || "—" },
      { label: "Source", value: "Company Balance" },
      { label: "Provider", value: /revolut/i.test(args.provider) ? "Revolut Business" : (args.provider || "—") },
      { label: "Service area", value: args.service_area_name || "—" },
    ],
    execution_note: "Draft only — no money moves yet",
  };
}
