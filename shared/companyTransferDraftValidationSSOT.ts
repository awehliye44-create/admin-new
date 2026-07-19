/**
 * Company Transfer draft validation & editable correction SSOT.
 * Pre-draft: never create a row when requested > Available Company Funds.
 * Amount mistakes → Edit Draft (stay DRAFT). Blocked queue = operational failures only.
 * Payment reference remains backend-generated / immutable (not an edit field).
 */

import {
  buildCompanyFundsProtectionBlock,
  formatPenceGbp,
  gateHasInsufficientCompanyFunds,
  type CompanyFundsProtectionBlock,
} from "./companyTransferLifecycleSSOT.ts";

export const COMPANY_TRANSFER_DRAFT_EDITABLE_FIELDS = [
  "amount_pence",
  "approved_amount_pence",
  "category",
  "scheduled_at",
  "cost_centre",
  "attachment_url",
  "purpose",
  "payee_id",
  "statement_reference",
  "notes",
] as const;

export type CompanyTransferDraftEditableField =
  (typeof COMPANY_TRANSFER_DRAFT_EDITABLE_FIELDS)[number];

/** Operational block reasons — belong in Blocked queue / Retry Validation. */
export const COMPANY_TRANSFER_OPERATIONAL_BLOCK_REASONS = new Set([
  "OPERATIONAL_RESERVE_NOT_CONFIGURED",
  "FINAL_COMPANY_FUNDS_UNAVAILABLE",
  "CLASSIFIED_COMPANY_CASH_UNAVAILABLE",
  "UNCLASSIFIED_COMPANY_CASH_PRESENT",
  "FUNDING_SNAPSHOT_MISMATCH",
  "PAYEE_UNVERIFIED",
  "PAYEE_INACTIVE",
  "PAYEE_NOT_LINKED",
  "PROVIDER_HARD_REJECT",
  "RELAY_UNREACHABLE",
  "LIVE_COMPANY_TRANSFER_EXECUTION_DISABLED",
]);

export type PreDraftFundsGateResult = {
  ok: boolean;
  reason: "OK" | "INSUFFICIENT_COMPANY_FUNDS" | "AVAILABLE_FUNDS_UNKNOWN";
  available_company_funds_pence: number | null;
  requested_pence: number;
  shortfall_pence: number;
  message: string | null;
  funds_protection: CompanyFundsProtectionBlock | null;
};

/** Inline pre-draft copy — never creates a blocked ledger row. */
export function buildPreDraftInsufficientFundsMessage(args: {
  available_company_funds_pence: number;
  requested_pence: number;
}): string {
  const available = Math.max(0, Math.round(args.available_company_funds_pence));
  const requested = Math.max(0, Math.round(args.requested_pence));
  const shortfall = Math.max(0, requested - available);
  return (
    `Requested transfer:\n${formatPenceGbp(requested)}\n\n`
    + `Available Company Funds:\n${formatPenceGbp(available)}\n\n`
    + `Shortfall:\n${formatPenceGbp(shortfall)}\n\n`
    + "This transfer cannot be drafted until sufficient company funds are available."
  );
}

export function evaluatePreDraftCompanyFundsGate(args: {
  requested_pence: number;
  available_company_funds_pence: number | null | undefined;
}): PreDraftFundsGateResult {
  const requested = Math.max(0, Math.round(Number(args.requested_pence) || 0));
  const availableRaw = args.available_company_funds_pence;
  if (availableRaw == null || !Number.isFinite(Number(availableRaw))) {
    return {
      ok: false,
      reason: "AVAILABLE_FUNDS_UNKNOWN",
      available_company_funds_pence: null,
      requested_pence: requested,
      shortfall_pence: requested,
      message:
        "Available Company Funds are unavailable. A draft cannot be created until company funds can be calculated.",
      funds_protection: null,
    };
  }
  const available = Math.max(0, Math.round(Number(availableRaw)));
  if (!(requested > 0)) {
    return {
      ok: false,
      reason: "INSUFFICIENT_COMPANY_FUNDS",
      available_company_funds_pence: available,
      requested_pence: requested,
      shortfall_pence: 0,
      message: "Requested amount must be a positive number of pence.",
      funds_protection: null,
    };
  }
  if (requested > available) {
    const protection = buildCompanyFundsProtectionBlock({
      available_company_funds_pence: available,
      requested_pence: requested,
    });
    return {
      ok: false,
      reason: "INSUFFICIENT_COMPANY_FUNDS",
      available_company_funds_pence: available,
      requested_pence: requested,
      shortfall_pence: protection.shortfall_pence,
      message: buildPreDraftInsufficientFundsMessage({
        available_company_funds_pence: available,
        requested_pence: requested,
      }),
      funds_protection: {
        ...protection,
        message: buildPreDraftInsufficientFundsMessage({
          available_company_funds_pence: available,
          requested_pence: requested,
        }),
      },
    };
  }
  return {
    ok: true,
    reason: "OK",
    available_company_funds_pence: available,
    requested_pence: requested,
    shortfall_pence: 0,
    message: null,
    funds_protection: null,
  };
}

export type LiveFundsShortfallDisplay = {
  available_pence: number | null;
  requested_pence: number | null;
  shortfall_pence: number;
  valid: boolean;
  available_label: string;
  requested_label: string;
  shortfall_label: string;
};

/** Live amount-field companion: green when valid, red when shortfall. */
export function buildLiveFundsShortfallDisplay(args: {
  available_company_funds_pence: number | null | undefined;
  requested_pence: number | null | undefined;
}): LiveFundsShortfallDisplay {
  const available = args.available_company_funds_pence == null
    || !Number.isFinite(Number(args.available_company_funds_pence))
    ? null
    : Math.max(0, Math.round(Number(args.available_company_funds_pence)));
  const requested = args.requested_pence == null
    || !Number.isFinite(Number(args.requested_pence))
    || Number(args.requested_pence) <= 0
    ? null
    : Math.max(0, Math.round(Number(args.requested_pence)));
  const shortfall = available != null && requested != null
    ? Math.max(0, requested - available)
    : 0;
  const valid = available != null && requested != null && requested <= available;
  return {
    available_pence: available,
    requested_pence: requested,
    shortfall_pence: shortfall,
    valid,
    available_label: available == null ? "unavailable" : formatPenceGbp(available),
    requested_label: requested == null ? "—" : formatPenceGbp(requested),
    shortfall_label: available == null || requested == null
      ? "—"
      : formatPenceGbp(shortfall),
  };
}

/**
 * True when block codes are amount/funds shortfall only — not operational.
 * These must not occupy the Blocked queue; fix via Edit Draft.
 */
export function isAmountValidationOnlyBlock(
  codes: ReadonlyArray<string> | null | undefined,
): boolean {
  const list = [...new Set((codes ?? []).map((c) => String(c).toUpperCase()).filter(Boolean))];
  if (list.length === 0) return false;
  if (!gateHasInsufficientCompanyFunds(list)) return false;
  return list.every((c) =>
    c === "INSUFFICIENT_COMPANY_FUNDS"
    || c === "INSUFFICIENT_FINAL_AVAILABLE"
    || c === "AMOUNT_INVALID"
  );
}

/** Blocked tab / Retry Validation — genuine operational failures. */
export function isOperationalCompanyTransferBlock(
  codes: ReadonlyArray<string> | null | undefined,
): boolean {
  const list = (codes ?? []).map((c) => String(c).toUpperCase());
  if (list.length === 0) return true; // unknown block → treat as operational
  if (isAmountValidationOnlyBlock(list)) return false;
  return list.some((c) => COMPANY_TRANSFER_OPERATIONAL_BLOCK_REASONS.has(c))
    || !gateHasInsufficientCompanyFunds(list);
}

export function canEditCompanyTransferAsDraft(args: {
  status: string | null | undefined;
  blocked_reason_codes?: ReadonlyArray<string> | null;
}): boolean {
  const status = String(args.status ?? "").toUpperCase();
  if (status === "DRAFT") return true;
  if (status === "BLOCKED" || status === "FUNDING_UNAVAILABLE") {
    // Amount / available-funds mistakes only — operational blocks use Retry Validation.
    return isAmountValidationOnlyBlock(args.blocked_reason_codes);
  }
  return false;
}

/** Retry Validation is for operational / balance / reserve / provider changes only. */
export function shouldShowRetryValidation(args: {
  status: string | null | undefined;
  blocked_reason_codes?: ReadonlyArray<string> | null;
}): boolean {
  const status = String(args.status ?? "").toUpperCase();
  if (!["BLOCKED", "FUNDING_UNAVAILABLE"].includes(status)) return false;
  return isOperationalCompanyTransferBlock(args.blocked_reason_codes);
}

export function shouldShowEditDraftAction(args: {
  status: string | null | undefined;
  blocked_reason_codes?: ReadonlyArray<string> | null;
}): boolean {
  return canEditCompanyTransferAsDraft(args);
}
