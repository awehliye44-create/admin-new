/**
 * Company Transfer Payment Reference SSOT.
 * Backend-generated, immutable, globally unique.
 * Admin never invents references for normal or certification drafts.
 *
 * Format:
 *   ONECAB-CT-YYMMDD-000001      — normal company transfer
 *   ONECAB-CERT-YYMMDD-000001    — certification / £0.01 proof
 *
 * Revolut Business reference limit: 100 chars (we stay well under).
 */

export const COMPANY_TRANSFER_PAYMENT_REFERENCE_MAX_LEN = 40;
/** Revolut /pay `reference` hard cap used by relay + slice12. */
export const COMPANY_TRANSFER_PROVIDER_REFERENCE_MAX_LEN = 100;

export const COMPANY_TRANSFER_PAYMENT_REFERENCE_PLATFORM = "ONECAB" as const;

export const COMPANY_TRANSFER_PAYMENT_REFERENCE_KIND = {
  CT: "CT",
  CERT: "CERT",
} as const;

export type CompanyTransferPaymentReferenceKind =
  (typeof COMPANY_TRANSFER_PAYMENT_REFERENCE_KIND)[keyof typeof COMPANY_TRANSFER_PAYMENT_REFERENCE_KIND];

/** Allocate RPC kind argument — maps transfer_type / form kind → CT|CERT. */
export function resolveCompanyTransferPaymentReferenceKind(
  transferTypeOrFormKind: string | null | undefined,
): CompanyTransferPaymentReferenceKind {
  const raw = String(transferTypeOrFormKind ?? "").trim().toUpperCase();
  if (raw === "CERTIFICATION" || raw === "CERT" || raw === "TEST_PROOF") {
    return COMPANY_TRANSFER_PAYMENT_REFERENCE_KIND.CERT;
  }
  return COMPANY_TRANSFER_PAYMENT_REFERENCE_KIND.CT;
}

/** YYMMDD in Europe/London (ops calendar). */
export function formatCompanyTransferReferenceDay(
  at: Date = new Date(),
  timeZone = "Europe/London",
): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const yy = parts.find((p) => p.type === "year")?.value ?? "00";
  const mm = parts.find((p) => p.type === "month")?.value ?? "00";
  const dd = parts.find((p) => p.type === "day")?.value ?? "00";
  return `${yy}${mm}${dd}`;
}

export function buildCompanyTransferPaymentReference(args: {
  kind: CompanyTransferPaymentReferenceKind;
  yymmdd: string;
  seq: number;
}): string {
  const seq = Math.max(1, Math.floor(Number(args.seq) || 1));
  const seqPad = String(seq).padStart(6, "0");
  const ref =
    `${COMPANY_TRANSFER_PAYMENT_REFERENCE_PLATFORM}-${args.kind}-${args.yymmdd}-${seqPad}`;
  if (ref.length > COMPANY_TRANSFER_PAYMENT_REFERENCE_MAX_LEN) {
    throw new Error("COMPANY_TRANSFER_PAYMENT_REFERENCE_TOO_LONG");
  }
  return ref;
}

/** UI preview before allocate — never consume a sequence. */
export function previewCompanyTransferPaymentReference(args: {
  transfer_type_or_kind?: string | null;
  at?: Date;
}): string {
  const kind = resolveCompanyTransferPaymentReferenceKind(args.transfer_type_or_kind);
  const yymmdd = formatCompanyTransferReferenceDay(args.at ?? new Date());
  return buildCompanyTransferPaymentReference({ kind, yymmdd, seq: 1 }).replace(
    /000001$/,
    "######",
  );
}

const REF_RE = /^ONECAB-(CT|CERT)-\d{6}-\d{6}$/;

export function isValidCompanyTransferPaymentReference(
  value: string | null | undefined,
): boolean {
  const v = String(value ?? "").trim();
  if (!v || v.length > COMPANY_TRANSFER_PAYMENT_REFERENCE_MAX_LEN) return false;
  return REF_RE.test(v);
}

/**
 * Provider payload reference: always the immutable SSOT payment_reference.
 * Optional statement_reference is stored separately and never replaces SSOT.
 */
export function resolveCompanyTransferProviderReference(args: {
  payment_reference: string | null | undefined;
  statement_reference?: string | null;
  transfer_ref?: string | null;
}): string {
  const ssot = String(args.payment_reference ?? "").trim();
  if (ssot) {
    return ssot.slice(0, COMPANY_TRANSFER_PROVIDER_REFERENCE_MAX_LEN);
  }
  const fallback = String(args.transfer_ref ?? "").trim();
  return fallback.slice(0, COMPANY_TRANSFER_PROVIDER_REFERENCE_MAX_LEN);
}

export function sanitizeCompanyTransferStatementReference(
  value: string | null | undefined,
): string | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  return v.slice(0, COMPANY_TRANSFER_PROVIDER_REFERENCE_MAX_LEN);
}
