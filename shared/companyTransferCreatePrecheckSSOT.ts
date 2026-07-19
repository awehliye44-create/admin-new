/**
 * Company Transfer create-draft precheck SSOT.
 * Each validator reports independently — never collapse into one generic blocker.
 * Field order: payee first ("Select a saved payee."), then other form fields, then funds.
 */

import {
  evaluatePreDraftCompanyFundsGate,
  resolveAvailableCompanyFundsPenceFromBalance,
  type PreDraftFundsGateResult,
} from "./companyTransferDraftValidationSSOT.ts";
import {
  validateCompanyTransferDraftForm,
  type CompanyTransferDraftFormValues,
  type CompanyTransferDraftValidation,
} from "./companyTransferFormUxSSOT.ts";
import {
  companyTransferGateReasonLabel,
  type CompanyTransferFundingSnapshot,
} from "./companyTransferLifecycleSSOT.ts";
import type { CompanyBalanceSnapshot } from "./companyBalanceSSOT.ts";

export const COMPANY_TRANSFER_PRECHECK_VALIDATOR_IDS = [
  "payee_selected",
  "payee_provider_verified",
  "company_funding_account",
  "available_company_funds",
  "requested_amount",
  "currency",
  "reserve_policy",
  "company_reconciliation",
  "company_live_execution",
  "approval_policy",
] as const;

export type CompanyTransferPrecheckValidatorId =
  (typeof COMPANY_TRANSFER_PRECHECK_VALIDATOR_IDS)[number];

export type CompanyTransferPrecheckValidatorResult = {
  id: CompanyTransferPrecheckValidatorId;
  label: string;
  ok: boolean;
  /** Present when ok is false — user-facing. */
  message: string | null;
  /** Machine code for logs / backend parity. */
  code: string | null;
  /** Evidence for debugging (never money-moving). */
  evidence?: Record<string, unknown>;
};

export type CompanyTransferCreatePrecheckResult = {
  ok: boolean;
  /** First failing validator in display order — payee before funds. */
  first_failing: CompanyTransferPrecheckValidatorResult | null;
  first_visible_error: string | null;
  validators: CompanyTransferPrecheckValidatorResult[];
  form: CompanyTransferDraftValidation;
  funds_gate: PreDraftFundsGateResult | null;
  requested_pence: number | null;
  available_company_funds_pence: number | null;
};

function pass(
  id: CompanyTransferPrecheckValidatorId,
  label: string,
  evidence?: Record<string, unknown>,
): CompanyTransferPrecheckValidatorResult {
  return { id, label, ok: true, message: null, code: null, evidence };
}

function fail(
  id: CompanyTransferPrecheckValidatorId,
  label: string,
  message: string,
  code: string,
  evidence?: Record<string, unknown>,
): CompanyTransferPrecheckValidatorResult {
  return { id, label, ok: false, message, code, evidence };
}

/**
 * Resolve available funds for precheck — same field the Available Company Funds card uses.
 * Prefer company_available_for_transfer_pence / final (aliases), never invent £0.
 */
export function resolvePrecheckAvailableCompanyFundsPence(
  companyBalance: CompanyBalanceSnapshot | null | undefined,
  fundingSnapshot?: Pick<CompanyTransferFundingSnapshot, "final_company_available_pence"> | null,
): number | null {
  // Match the ledger card: company_available_for_transfer_pence first.
  const cardField = companyBalance?.company_available_for_transfer_pence;
  if (cardField != null && Number.isFinite(Number(cardField))) {
    return Math.max(0, Math.round(Number(cardField)));
  }
  return resolveAvailableCompanyFundsPenceFromBalance(companyBalance, fundingSnapshot);
}

/**
 * Independent create-draft precheck.
 * Company funds validator MUST pass when available ≥ requested (e.g. 774p vs 1p).
 */
export function evaluateCompanyTransferCreatePrecheck(args: {
  form: CompanyTransferDraftFormValues;
  payee_provider_verified: boolean;
  payee_currency?: string | null;
  context_service_area_id?: string | null;
  company_balance?: CompanyBalanceSnapshot | null;
  funding_snapshot?: CompanyTransferFundingSnapshot | null;
  live_company_transfer_execution_enabled?: boolean;
  require_separate_approved_amount?: boolean;
}): CompanyTransferCreatePrecheckResult {
  const form = validateCompanyTransferDraftForm({
    form: args.form,
    payee_provider_verified: args.payee_provider_verified,
    payee_currency: args.payee_currency,
    context_service_area_id: args.context_service_area_id,
    require_separate_approved_amount: args.require_separate_approved_amount,
  });

  const available = resolvePrecheckAvailableCompanyFundsPence(
    args.company_balance,
    args.funding_snapshot,
  );
  const requested = form.amount_pence;

  const payeeSelected = Boolean(String(args.form.payee_id ?? "").trim());
  const validators: CompanyTransferPrecheckValidatorResult[] = [];

  // 1) Payee selected — FIRST visible error when missing
  validators.push(
    payeeSelected
      ? pass("payee_selected", "Payee selected", { payee_id: args.form.payee_id })
      : fail(
        "payee_selected",
        "Payee selected",
        "Select a saved payee.",
        "PAYEE_REQUIRED",
      ),
  );

  // 2) Payee provider verified (only when payee selected)
  if (!payeeSelected) {
    validators.push(
      fail(
        "payee_provider_verified",
        "Payee provider verified",
        "Select a saved payee.",
        "PAYEE_REQUIRED",
      ),
    );
  } else if (!args.payee_provider_verified) {
    validators.push(
      fail(
        "payee_provider_verified",
        "Payee provider verified",
        form.byField.payee_id
          ?? "Recipient must be linked to Revolut before the transfer can be submitted.",
        "PAYEE_UNVERIFIED",
      ),
    );
  } else {
    validators.push(pass("payee_provider_verified", "Payee provider verified"));
  }

  // 3) Company funding account found
  const sourceId = args.company_balance?.source_account_id
    ?? args.funding_snapshot?.source_account_id
    ?? null;
  const sourceLabel = args.company_balance?.source_account_label ?? null;
  if (!sourceId && !String(args.form.source_account ?? "").trim()) {
    validators.push(
      fail(
        "company_funding_account",
        "Company funding account found",
        "Company funding account is not configured.",
        "SOURCE_ACCOUNT_NOT_CONFIGURED",
      ),
    );
  } else {
    validators.push(
      pass("company_funding_account", "Company funding account found", {
        source_account_id: sourceId,
        source_account_label: sourceLabel,
      }),
    );
  }

  // 4) Available company funds (presence / calculable)
  if (available == null) {
    validators.push(
      fail(
        "available_company_funds",
        "Available company funds",
        "Available Company Funds are unavailable. A draft cannot be created until company funds can be calculated.",
        "AVAILABLE_FUNDS_UNKNOWN",
        { available_company_funds_pence: null },
      ),
    );
  } else {
    validators.push(
      pass("available_company_funds", "Available company funds", {
        available_company_funds_pence: available,
      }),
    );
  }

  // 5) Requested amount (positive pence + ≤ available when known)
  let fundsGate: PreDraftFundsGateResult | null = null;
  if (requested == null || !(requested > 0)) {
    validators.push(
      fail(
        "requested_amount",
        "Requested amount",
        form.byField.amount_pence
          ?? "Requested amount must be a positive number of pence (example: 1 = £0.01).",
        "AMOUNT_INVALID",
        { requested_pence: requested },
      ),
    );
  } else {
    fundsGate = evaluatePreDraftCompanyFundsGate({
      requested_pence: requested,
      available_company_funds_pence: available,
    });
    if (!fundsGate.ok) {
      validators.push(
        fail(
          "requested_amount",
          "Requested amount",
          fundsGate.message
            ?? "Requested amount exceeds Available Company Funds.",
          fundsGate.reason,
          {
            requested_pence: fundsGate.requested_pence,
            available_company_funds_pence: fundsGate.available_company_funds_pence,
            shortfall_pence: fundsGate.shortfall_pence,
          },
        ),
      );
    } else {
      // Explicit proof: available ≥ requested
      validators.push(
        pass("requested_amount", "Requested amount", {
          requested_pence: requested,
          available_company_funds_pence: available,
          comparison: "requested_lte_available",
        }),
      );
    }
  }

  // 6) Currency
  if (form.byField.currency) {
    validators.push(
      fail(
        "currency",
        "Currency",
        form.byField.currency,
        "CURRENCY_INVALID",
        { currency: args.form.currency },
      ),
    );
  } else {
    validators.push(
      pass("currency", "Currency", {
        currency: String(args.form.currency ?? "").toUpperCase() || "GBP",
      }),
    );
  }

  // 7) Reserve policy — submit/execute gate only (draft create does not require it).
  const snap = args.funding_snapshot;
  const reserveStatus = String(
    snap?.operational_reserve_status
      ?? args.company_balance?.sections?.operational_reserve?.status
      ?? "",
  ).toUpperCase();
  const reserveReason = String(
    snap?.operational_reserve_reason_code
      ?? args.company_balance?.sections?.operational_reserve?.reason_code
      ?? "",
  ).toUpperCase();
  const reservePence = snap?.operational_reserve_pence
    ?? args.company_balance?.operational_reserve_pence
    ?? null;
  const reserveOk = reservePence != null
    && (reserveStatus === "ACTIVE" || reserveStatus === "AVAILABLE")
    && reserveReason !== "OPERATIONAL_RESERVE_NOT_CONFIGURED";
  validators.push(
    pass("reserve_policy", "Reserve policy", {
      operational_reserve_pence: reservePence,
      operational_reserve_status: reserveStatus || null,
      operational_reserve_reason_code: reserveReason || null,
      draft_create_ok: true,
      submit_requires_active_reserve: !reserveOk,
      note: reserveOk
        ? "ACTIVE reserve policy loaded"
        : "Configure ACTIVE reserve before Submit for Approval (draft create allowed)",
    }),
  );

  // 8) Company reconciliation — submit gate only when final unavailable + unclassified.
  const finalAuthoritative = snap?.final_available_authoritative === true
    || (available != null && reserveOk);
  const unclassified = snap?.unclassified_company_cash_pence ?? null;
  const unclassifiedBlocking = !finalAuthoritative
    && (
      (unclassified != null && unclassified > 0)
      || String(snap?.unclassified_status ?? "").toUpperCase() === "RECONCILIATION_REQUIRED"
    );
  validators.push(
    pass("company_reconciliation", "Company reconciliation", {
      unclassified_company_cash_pence: unclassified,
      final_available_authoritative: finalAuthoritative,
      draft_create_ok: true,
      submit_requires_reconciliation: unclassifiedBlocking,
      note: unclassifiedBlocking
        ? "Unclassified cash blocks Submit until final available is authoritative (draft create allowed)"
        : "No unclassified blocker for draft",
    }),
  );

  // 9) Company LIVE execution — informational for draft create (drafts allowed when LIVE off)
  const live = args.live_company_transfer_execution_enabled === true;
  validators.push(
    pass("company_live_execution", "Company LIVE execution", {
      live_company_transfer_execution_enabled: live,
      draft_allowed_when_live_off: true,
      note: live
        ? "LIVE execution enabled — submit may move company money after approval."
        : "LIVE execution off — draft/approval allowed; provider submit blocked.",
    }),
  );

  // 10) Approval policy — draft create does not require approvals yet
  const approvedRaw = String(args.form.approved_amount_pence ?? "").trim();
  if (args.require_separate_approved_amount && (!approvedRaw || !(Math.round(Number(approvedRaw)) > 0))) {
    validators.push(
      fail(
        "approval_policy",
        "Approval policy",
        "Approved amount is required by approval policy.",
        "APPROVED_AMOUNT_REQUIRED",
      ),
    );
  } else {
    validators.push(
      pass("approval_policy", "Approval policy", {
        start_mode: args.form.start_mode,
        draft_create_does_not_require_approvals: true,
      }),
    );
  }

  // Also surface remaining form field errors that aren't covered above (category, purpose, …)
  // without changing the payee-first order of `validators` for the listed IDs.
  const first_failing = validators.find((v) => !v.ok) ?? null;
  // Prefer payee message even if an earlier funds UI path ran — validators are already ordered.
  let first_visible_error = first_failing?.message ?? null;
  if (!payeeSelected) {
    first_visible_error = "Select a saved payee.";
  } else if (form.errors.length > 0 && form.errors[0]?.field === "payee_id") {
    first_visible_error = form.errors[0].message;
  }

  // Create-draft ok: form ok + funds ok when amount present. Reserve/reconciliation
  // remain reported independently — draft create historically only hard-blocked on
  // form + pre-draft funds (backend funding gate runs on non-draft / submit).
  const fundsOkForDraft = requested == null || requested <= 0
    ? false
    : (fundsGate?.ok === true);
  const ok = form.ok && fundsOkForDraft && available != null;

  return {
    ok,
    first_failing: !payeeSelected
      ? validators.find((v) => v.id === "payee_selected") ?? first_failing
      : first_failing,
    first_visible_error,
    validators,
    form,
    funds_gate: fundsGate
      ?? (requested != null && requested > 0
        ? evaluatePreDraftCompanyFundsGate({
          requested_pence: requested,
          available_company_funds_pence: available,
        })
        : null),
    requested_pence: requested,
    available_company_funds_pence: available,
  };
}

/** True when company funds alone would allow this request (ignores payee / other fields). */
export function companyFundsPrecheckPasses(args: {
  available_company_funds_pence: number | null | undefined;
  requested_pence: number | null | undefined;
}): boolean {
  const gate = evaluatePreDraftCompanyFundsGate({
    requested_pence: Math.max(0, Math.round(Number(args.requested_pence) || 0)),
    available_company_funds_pence: args.available_company_funds_pence,
  });
  return gate.ok === true;
}
