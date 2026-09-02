/**
 * Company Balance SSOT — company-owned money only.
 * Never consume Driver Wallet live/available/pending/debt.
 * Never invent provider cash as £0 when evidence is missing.
 *
 * Slice 10 final available uses safer transferable_base:
 *   min(eligible_company_cash, classified_company_cash) − operational_reserve
 * Unclassified / RECONCILIATION_REQUIRED cash is never transferable.
 */

import {
  computeEligibleCompanyCashPence,
  computeFinalCompanyAvailablePence,
  OPERATIONAL_RESERVE_ERROR,
} from "./companyOperationalReserveSSOT.ts";
import {
  COMPANY_FUNDS_UNDERPROTECTED,
  evaluateCompanyFundsUnderprotection,
} from "../../../shared/companyFundsUnderprotectionSSOT.ts";

export {
  COMPANY_FUNDS_UNDERPROTECTED,
  evaluateCompanyFundsUnderprotection,
  type CompanyFundsUnderprotectionEvaluation,
} from "../../../shared/companyFundsUnderprotectionSSOT.ts";

export const COMPANY_BALANCE_ERROR = {
  SOURCE_UNAVAILABLE: "COMPANY_BALANCE_SOURCE_UNAVAILABLE",
  PROVIDER_STUB_ZERO: "COMPANY_BALANCE_PROVIDER_STUB_REJECTED",
  FUNDING_UNAVAILABLE: "FUNDING_UNAVAILABLE",
  FORBIDDEN_DRIVER_WALLET: "FORBIDDEN_COMPANY_SOURCE_DRIVER_WALLET",
  /** Preferred code when no Use-as-source account is selected. */
  SOURCE_ACCOUNT_NOT_CONFIGURED: "SOURCE_ACCOUNT_NOT_CONFIGURED",
  /** @deprecated Prefer SOURCE_ACCOUNT_NOT_CONFIGURED */
  ACCOUNT_NOT_CONFIGURED: "ACCOUNT_NOT_CONFIGURED",
  AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_CONNECTION_UNAVAILABLE: "PROVIDER_CONNECTION_UNAVAILABLE",
  /** Preferred when selected Revolut source cash cannot be read. */
  PROVIDER_BALANCE_UNAVAILABLE: "PROVIDER_BALANCE_UNAVAILABLE",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  STALE_PROVIDER_EVIDENCE: "STALE_PROVIDER_EVIDENCE",
  BALANCE_STALE: "BALANCE_STALE",
  DRIVER_LIABILITY_QUERY_FAILED: "DRIVER_LIABILITY_QUERY_FAILED",
  TRANSFER_DISABLED: "TRANSFER_DISABLED",
  PENDING_SYNC: "PENDING_SYNC",
} as const;

/** Card / section labels — display only; never redefine money SSOT. */
export const COMPANY_BALANCE_LABELS = {
  REVOLUT_SOURCE_ACCOUNT_BALANCE: "Revolut Source Account Balance",
  PROVIDER_AVAILABLE_CASH: "Provider Available Cash",
  PROTECTED_DRIVER_LIABILITIES: "Protected Driver Liabilities",
  RESERVED_DRIVER_PAYOUTS: "Reserved Driver Payouts",
  APPROVED_COMPANY_PAYABLES: "Approved Company Payables",
  ONECAB_NET_COMMISSION_AVAILABLE: "Recognised ONECAB Net Commission",
  /** @deprecated Prefer UNCLASSIFIED_COMPANY_CASH */
  OTHER_COMPANY_OWNED_CASH: "Unclassified Company Cash",
  UNCLASSIFIED_COMPANY_CASH: "Unclassified Company Cash",
  OPERATIONAL_REFUND_RESERVE: "Operational / Refund Reserve",
  ONECAB_AVAILABLE_COMPANY_FUNDS: "ONECAB Real Available Funds",
  ONECAB_CASH_AVAILABLE_BEFORE_OPERATIONAL_RESERVE: "ONECAB Funds Before Reserve",
  DRIVER_PAYOUT_FUNDING_STATUS: "Driver Payout Funding Status",
  FUNDING_GAP: "Funding Gap",
} as const;

export const COMPANY_BALANCE_TOOLTIPS = {
  REVOLUT_SOURCE_ACCOUNT_BALANCE:
    "Total available cash in the selected Revolut Business account. This includes protected driver and company liabilities.",
  ONECAB_AVAILABLE_COMPANY_FUNDS:
    "Spendable company transfer budget from live Revolut liquidity after protected driver liabilities, approved payables, and operational/refund reserve. Always capped by live Revolut source balance and ONECAB funds before reserve. Never includes Payment Sessions commission totals. When the reserve is NOT_CONFIGURED, real available funds stay UNAVAILABLE (not silent £0).",
  ONECAB_AVAILABLE_BEFORE_OPERATIONAL_RESERVE:
    "ONECAB-owned liquidity before operational reserve: Revolut source − protected driver liabilities − approved company payables (− customer refund reserve when configured). Not all of this amount is current-period commission.",
  APPROVED_COMPANY_PAYABLES:
    "Approved or awaiting-approval company outgoing transfers — deducted from company funds before reserve (not driver wallet money).",
  PROTECTED_DRIVER_LIABILITIES:
    "Driver money protected from company use: live wallet, pending clearing entitlement, active payout reservations, in-flight provider transfers, terminal-fee compensation owed, and unresolved payout obligations. A £0.00 figure on an older deploy may omit pending-clearing entitlements until company-funds gap closure is live.",
  ONECAB_NET_COMMISSION_AVAILABLE:
    "Recognised commission can be higher than current Revolut balance because cash may already have been paid out, reserved, refunded, transferred, or classified historically. It is not a spendable balance.",
  OTHER_COMPANY_OWNED_CASH:
    "Unclassified residual company-owned cash after recognised Payment Sessions net commission. Never commission; status RECONCILIATION_REQUIRED until classified. Not silently transferable.",
  UNCLASSIFIED_COMPANY_CASH:
    "Unclassified residual company-owned cash after recognised Payment Sessions net commission. Never commission; status RECONCILIATION_REQUIRED until classified. Not silently transferable.",
  RESERVED_DRIVER_PAYOUTS:
    "Display-only: ACTIVE driver_payout_reservations. Included in Protected Driver Liabilities when computing company funds — shown separately for operational visibility.",
} as const;

/** Payout Ledger company-funding section headings (display only). */
export const COMPANY_FUNDING_SECTIONS = {
  LIQUIDITY_AND_PROTECTION: "Liquidity & protection",
  /** @deprecated Prefer LIQUIDITY_AND_PROTECTION */
  TRANSFERABLE_FUNDS: "Liquidity & protection",
  ACCOUNTING_DIAGNOSTICS: "Accounting diagnostics",
  /** @deprecated Prefer ACCOUNTING_DIAGNOSTICS */
  ACCOUNTING_CLASSIFICATION: "Accounting diagnostics",
  /** @deprecated Reserved payouts moved into main liquidity grid */
  OPERATIONAL_VISIBILITY: "Operational visibility",
} as const;

export const COMPANY_BALANCE_COMMISSION_SUBTITLE =
  "Accounting total from Payment Sessions. Not cash availability.";

export const COMPANY_BALANCE_LABELS_EXTENDED = {
  ONECAB_AVAILABLE_BEFORE_OPERATIONAL_RESERVE:
    "ONECAB Available Before Operational Reserve",
  COMPLETED_DRIVER_PAYOUTS_THIS_MONTH: "Completed Driver Payouts This Month",
  COMPLETED_COMPANY_TRANSFERS_THIS_MONTH: "Completed Company Transfers This Month",
} as const;

export type DriverPayoutFundingStatus = "FULLY_FUNDED" | "UNDERFUNDED" | "UNAVAILABLE";

export type CompanyBalanceSectionStatus =
  | "AVAILABLE"
  | "UNAVAILABLE"
  | "STALE"
  | "NOT_CONFIGURED"
  | "ERROR";

export type CompanyBalanceSectionAmount = {
  status: CompanyBalanceSectionStatus;
  amount_pence: number | null;
  currency?: string;
  reason_code?: string | null;
};

export type CompanyBalanceStatusCode =
  | "AVAILABLE"
  | "PENDING_SYNC"
  | "AUTHENTICATION_REQUIRED"
  | "SOURCE_ACCOUNT_NOT_CONFIGURED"
  | "ACCOUNT_NOT_CONFIGURED"
  | "CURRENCY_MISMATCH"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_CONNECTION_UNAVAILABLE"
  | "STALE_PROVIDER_EVIDENCE"
  | "BALANCE_STALE"
  | "TRANSFER_DISABLED";

export type CompanyBalanceEvidenceStatus =
  | "CONFIRMED"
  | "PARTIAL"
  | "NO_CANONICAL_SOURCE"
  | "PROVIDER_STUB"
  | "UNVERIFIED"
  | CompanyBalanceStatusCode;

export type CompanyBalanceSnapshot = {
  status: "LIVE" | "PARTIAL" | "UNAVAILABLE";
  status_code: CompanyBalanceStatusCode | typeof COMPANY_BALANCE_ERROR[keyof typeof COMPANY_BALANCE_ERROR];
  currency: string;
  service_area_id: string | null;
  generated_at: string;
  last_verified_at: string | null;
  last_provider_sync_at: string | null;
  source_account_id: string | null;
  source_account_label: string | null;
  connection_status: CompanyBalanceStatusCode;
  connection_health: CompanyBalanceSectionStatus;
  /** Internal ONECAB company ledger — null when no ledger source exists. */
  company_ledger_balance_pence: number | null;
  /** Confirmed Revolut Business / provider cash — null when not verified. */
  provider_cash_balance_pence: number | null;
  provider_current_balance_pence: number | null;
  provider_available_balance_pence: number | null;
  driver_liability_pence: number | null;
  driver_payout_reserved_pence: number | null;
  customer_refund_reserved_pence: number | null;
  approved_company_payables_pence: number | null;
  operational_reserve_pence: number | null;
  /**
   * Safe transferable amount (= final_company_available_pence / ONECAB available).
   * Null when unknown, operational reserve NOT_CONFIGURED, or classified cash missing.
   * Must never equal driver wallet liabilities / source / unclassified residual.
   */
  company_available_for_transfer_pence: number | null;
  /**
   * Alias of company_available_for_transfer_pence (Slice 10 naming).
   * Present on snapshot for gate consumers; always equal when either set.
   */
  final_company_available_pence?: number | null;
  /**
   * Provisional residual = source − liabilities − payables (− customer refund if set)
   * = eligible_company_cash. Present even when reserve NOT_CONFIGURED — never final.
   */
  company_available_before_operational_reserve_pence: number | null;
  /** Slice 10: recognised classified funding only (excludes UNATTRIBUTED). */
  classified_company_cash_pence?: number | null;
  /** Slice 10: min(eligible, classified) before reserve deduction. */
  transferable_base_pence?: number | null;
  /** @deprecated alias of approved_company_payables_pence */
  approved_payables_pending_pence: number | null;
  /** Whether provider cash covers protected driver liabilities. */
  driver_payout_funding_status: DriverPayoutFundingStatus;
  /** max(0, protected liabilities − provider cash); null when either input unknown. */
  funding_gap_pence: number | null;
  /** Protected liabilities + approved payables exceed Revolut source — company transfers blocked. */
  company_funds_underprotected?: boolean;
  company_funds_underprotected_reason_code?: string | null;
  company_funds_underprotected_message?: string | null;
  company_funds_underprotected_shortfall_pence?: number | null;
  evidence_status: CompanyBalanceEvidenceStatus;
  unavailable_reason: string | null;
  source_label: string;
  /** Explicit proof that DWL was not used as provider cash. */
  excludes_driver_wallet: true;
  /** Per-section status — never invent £0 for missing sections. */
  sections?: {
    provider_balance: CompanyBalanceSectionAmount;
    driver_liabilities: CompanyBalanceSectionAmount;
    reserved_driver_payouts: CompanyBalanceSectionAmount;
    approved_company_payables: CompanyBalanceSectionAmount;
    operational_reserve: CompanyBalanceSectionAmount;
    company_transfer_available: CompanyBalanceSectionAmount;
  };
};

export type CompanyBalanceSourceAudit = {
  candidate: string;
  kind: "table" | "rpc" | "edge" | "provider" | "adapter";
  exists: boolean;
  usable_for_company_balance: boolean;
  notes: string;
};

/** Static audit of known candidates (no invented balances). */
export function auditCompanyBalanceSourceCandidates(): CompanyBalanceSourceAudit[] {
  return [
    {
      candidate: "company_outgoing_transfers",
      kind: "table",
      exists: true,
      usable_for_company_balance: false,
      notes: "Tracks outgoing transfers; not a cash balance source.",
    },
    {
      candidate: "driver_wallet_ledger",
      kind: "table",
      exists: true,
      usable_for_company_balance: false,
      notes: "Driver liability domain — forbidden as company balance.",
    },
    {
      candidate: "revolutAdapter.getBalance (merchant stub)",
      kind: "adapter",
      exists: true,
      usable_for_company_balance: false,
      notes: "Legacy stub returned available_pence: 0 — rejected.",
    },
    {
      candidate: "revolut Business API GET /accounts",
      kind: "provider",
      exists: true,
      usable_for_company_balance: true,
      notes: "Requires business_access_token + REVOLUT_SOURCE_BUSINESS_ACCOUNT_ID (merchant_id).",
    },
    {
      candidate: "providerAdapter.getBalance",
      kind: "adapter",
      exists: true,
      usable_for_company_balance: false,
      notes: "provider retired for runtime payouts — forbidden.",
    },
    {
      candidate: "company_ledger / treasury table",
      kind: "table",
      exists: false,
      usable_for_company_balance: false,
      notes: "No canonical ONECAB company ledger table found.",
    },
  ];
}

/**
 * Provisional residual before operational reserve (= eligible_company_cash):
 *   max(0, revolut_source − liabilities − approved_payables − customer_refund)
 */
export function computeCompanyAvailableBeforeOperationalReservePence(args: {
  provider_available_balance_pence: number | null;
  driver_liability_pence?: number | null;
  customer_refund_reserved_pence?: number | null;
  approved_company_payables_pence?: number | null;
}): number | null {
  return computeEligibleCompanyCashPence(args);
}

/**
 * Hard cap: company transferable funds never exceed live Revolut cash or before-reserve liquidity.
 */
export function capCompanyTransferableFundsPence(args: {
  amount_pence: number | null;
  provider_available_balance_pence: number | null;
  before_operational_reserve_pence: number | null;
}): number | null {
  if (args.amount_pence == null) return null;
  let capped = Math.max(0, Math.round(args.amount_pence));
  if (args.provider_available_balance_pence != null) {
    capped = Math.min(
      capped,
      Math.max(0, Math.round(args.provider_available_balance_pence)),
    );
  }
  if (args.before_operational_reserve_pence != null) {
    capped = Math.min(
      capped,
      Math.max(0, Math.round(args.before_operational_reserve_pence)),
    );
  }
  return capped;
}

/**
 * UI liquidity-only real available funds — never capped by Payment Sessions commission.
 * Backend transfer gates may still use classified_company_cash_pence separately.
 */
export function computeRealAvailableCompanyFundsPence(args: {
  company_available_before_operational_reserve_pence: number | null;
  operational_reserve_pence: number | null;
  operational_reserve_configured: boolean;
  provider_available_balance_pence: number | null;
  company_funds_underprotected?: boolean;
}): number | null {
  if (args.company_funds_underprotected) return 0;
  if (args.company_available_before_operational_reserve_pence == null) return null;
  if (!args.operational_reserve_configured || args.operational_reserve_pence == null) {
    return null;
  }
  const raw = Math.max(
    0,
    args.company_available_before_operational_reserve_pence
      - Math.max(0, Math.round(args.operational_reserve_pence)),
  );
  return capCompanyTransferableFundsPence({
    amount_pence: raw,
    provider_available_balance_pence: args.provider_available_balance_pence,
    before_operational_reserve_pence: args.company_available_before_operational_reserve_pence,
  });
}

  /**
   * ONECAB available company funds (authoritative, fail-closed — Slice 10):
   *   eligible = max(0, source − protected_liabilities − approved_payables [− customer_refund])
   *   transferable_base = min(eligible, classified_company_cash)
   *   final = max(0, transferable_base − operational_reserve)
   *
   * Protected liabilities include pending clearing, reservations, in-flight transfers, etc.
   * Reserved payouts shown separately for visibility — already in protected_liabilities total.
   * Unconfigured operational reserve (null) → null (NOT silent £0).
   * Missing classified cash → null (unclassified excluded from transferable).
   */
export function computeCompanyAvailableForTransferPence(args: {
  provider_available_balance_pence: number | null;
  driver_liability_pence?: number | null;
  /** Display-only — never deducted (subset of live liabilities). */
  driver_payout_reserved_pence?: number | null;
  customer_refund_reserved_pence?: number | null;
  approved_company_payables_pence?: number | null;
  operational_reserve_pence?: number | null;
  /** Required Slice 10 — recognised net commission + other classified funding. */
  classified_company_cash_pence?: number | null;
}): number | null {
  void args.driver_payout_reserved_pence;
  if (args.provider_available_balance_pence == null) return null;
  if (args.driver_liability_pence === null) return null;
  if (args.operational_reserve_pence === null || args.operational_reserve_pence === undefined) {
    return null;
  }
  if (args.classified_company_cash_pence == null) {
    return null;
  }
  const eligible = computeEligibleCompanyCashPence({
    provider_available_balance_pence: args.provider_available_balance_pence,
    driver_liability_pence: args.driver_liability_pence,
    customer_refund_reserved_pence: args.customer_refund_reserved_pence,
    approved_company_payables_pence: args.approved_company_payables_pence,
  });
  return computeFinalCompanyAvailablePence({
    eligible_company_cash_pence: eligible,
    classified_company_cash_pence: args.classified_company_cash_pence,
    operational_reserve_pence: args.operational_reserve_pence,
  });
}

/** Provider cash covering protected driver liabilities (not company-transfer residual). */
export function computeDriverPayoutFunding(args: {
  provider_available_balance_pence: number | null;
  driver_liability_pence: number | null;
}): { status: DriverPayoutFundingStatus; gap_pence: number | null } {
  if (args.provider_available_balance_pence == null || args.driver_liability_pence == null) {
    return { status: "UNAVAILABLE", gap_pence: null };
  }
  const gap = Math.max(0, args.driver_liability_pence - args.provider_available_balance_pence);
  return {
    status: gap === 0 ? "FULLY_FUNDED" : "UNDERFUNDED",
    gap_pence: gap,
  };
}

/** Configured operational + refund reserves for display (unknown → 0 when provider live). */
export function computeOperationalRefundReservePence(args: {
  operational_reserve_pence?: number | null;
  customer_refund_reserved_pence?: number | null;
}): number {
  return Math.max(0, Number(args.operational_reserve_pence ?? 0))
    + Math.max(0, Number(args.customer_refund_reserved_pence ?? 0));
}

function sectionAmount(
  amount: number | null | undefined,
  opts?: { reason_code?: string | null; currency?: string; notConfigured?: boolean },
): CompanyBalanceSectionAmount {
  if (amount == null) {
    return {
      status: opts?.notConfigured ? "NOT_CONFIGURED" : "UNAVAILABLE",
      amount_pence: null,
      currency: opts?.currency,
      reason_code: opts?.reason_code ?? null,
    };
  }
  return {
    status: "AVAILABLE",
    amount_pence: amount,
    currency: opts?.currency,
    reason_code: null,
  };
}

function buildSections(args: {
  currency: string;
  provider: number | null;
  driver_liability_pence: number | null;
  driver_payout_reserved_pence: number | null;
  approved: number | null;
  operational_reserve_pence: number | null;
  available: number | null;
  provider_reason?: string | null;
  notConfigured?: boolean;
}): NonNullable<CompanyBalanceSnapshot["sections"]> {
  return {
    provider_balance: sectionAmount(args.provider, {
      currency: args.currency,
      reason_code: args.provider_reason,
      notConfigured: args.notConfigured,
    }),
    driver_liabilities: sectionAmount(args.driver_liability_pence, { currency: args.currency }),
    reserved_driver_payouts: sectionAmount(args.driver_payout_reserved_pence, { currency: args.currency }),
    approved_company_payables: sectionAmount(args.approved, { currency: args.currency }),
    operational_reserve: sectionAmount(args.operational_reserve_pence, { currency: args.currency }),
    company_transfer_available: sectionAmount(args.available, {
      currency: args.currency,
      reason_code: args.available == null ? args.provider_reason : null,
      notConfigured: args.notConfigured,
    }),
  };
}

function connectionHealthFromCode(code: string | null): CompanyBalanceSectionStatus {
  if (!code || code === "AVAILABLE") return "AVAILABLE";
  if (
    code === COMPANY_BALANCE_ERROR.SOURCE_ACCOUNT_NOT_CONFIGURED
    || code === COMPANY_BALANCE_ERROR.ACCOUNT_NOT_CONFIGURED
  ) {
    return "NOT_CONFIGURED";
  }
  if (code === COMPANY_BALANCE_ERROR.STALE_PROVIDER_EVIDENCE || code === COMPANY_BALANCE_ERROR.BALANCE_STALE) {
    return "STALE";
  }
  if (
    code === COMPANY_BALANCE_ERROR.PROVIDER_UNAVAILABLE
    || code === COMPANY_BALANCE_ERROR.PROVIDER_CONNECTION_UNAVAILABLE
    || code === COMPANY_BALANCE_ERROR.PROVIDER_BALANCE_UNAVAILABLE
    || code === COMPANY_BALANCE_ERROR.AUTHENTICATION_REQUIRED
  ) {
    return "ERROR";
  }
  return "UNAVAILABLE";
}

function fundingFields(
  provider: number | null | undefined,
  liability: number | null | undefined,
): Pick<CompanyBalanceSnapshot, "driver_payout_funding_status" | "funding_gap_pence"> {
  const funding = computeDriverPayoutFunding({
    provider_available_balance_pence: provider ?? null,
    driver_liability_pence: liability ?? null,
  });
  return {
    driver_payout_funding_status: funding.status,
    funding_gap_pence: funding.gap_pence,
  };
}

/**
 * Resolve company balance from proven sources only.
 */
export function resolveCompanyBalanceSnapshot(args?: {
  service_area_id?: string | null;
  currency?: string | null;
  company_ledger_balance_pence?: number | null;
  provider_cash_balance_pence?: number | null;
  provider_current_balance_pence?: number | null;
  provider_available_balance_pence?: number | null;
  approved_payables_pending_pence?: number | null;
  approved_company_payables_pence?: number | null;
  driver_liability_pence?: number | null;
  driver_payout_reserved_pence?: number | null;
  customer_refund_reserved_pence?: number | null;
  operational_reserve_pence?: number | null;
  /**
   * When operational_reserve_pence is null, preserve the loader/gate reason
   * (NOT_CONFIGURED / QUERY_FAILED / STALE / …) instead of collapsing to silent zero.
   */
  operational_reserve_reason_code?: string | null;
  /** Slice 10 classified funding (excludes UNATTRIBUTED / RECONCILIATION_REQUIRED). */
  classified_company_cash_pence?: number | null;
  provider_balance_is_stub?: boolean;
  status_code?: CompanyBalanceStatusCode | string | null;
  source_account_id?: string | null;
  source_account_label?: string | null;
  last_provider_sync_at?: string | null;
  refresh_requested?: boolean;
  now?: Date;
}): CompanyBalanceSnapshot {
  const generated_at = (args?.now ?? new Date()).toISOString();
  const currency = String(args?.currency ?? "GBP").toUpperCase() || "GBP";
  const service_area_id = args?.service_area_id ?? null;
  const approved = args?.approved_company_payables_pence
    ?? args?.approved_payables_pending_pence
    ?? null;

  if (args?.provider_balance_is_stub) {
    const sections = buildSections({
      currency,
      provider: null,
      driver_liability_pence: args.driver_liability_pence ?? null,
      driver_payout_reserved_pence: args.driver_payout_reserved_pence ?? null,
      approved,
      operational_reserve_pence: args.operational_reserve_pence ?? null,
      available: null,
      provider_reason: COMPANY_BALANCE_ERROR.PROVIDER_STUB_ZERO,
    });
    return {
      status: "UNAVAILABLE",
      status_code: COMPANY_BALANCE_ERROR.PROVIDER_STUB_ZERO,
      currency,
      service_area_id,
      generated_at,
      last_verified_at: null,
      last_provider_sync_at: null,
      source_account_id: args.source_account_id ?? null,
      source_account_label: args.source_account_label ?? null,
      connection_status: "PROVIDER_UNAVAILABLE",
      connection_health: "ERROR",
      company_ledger_balance_pence: null,
      provider_cash_balance_pence: null,
      provider_current_balance_pence: null,
      provider_available_balance_pence: null,
      driver_liability_pence: args.driver_liability_pence ?? null,
      driver_payout_reserved_pence: args.driver_payout_reserved_pence ?? null,
      customer_refund_reserved_pence: args.customer_refund_reserved_pence ?? null,
      approved_company_payables_pence: approved,
      operational_reserve_pence: args.operational_reserve_pence ?? null,
      company_available_for_transfer_pence: null,
      company_available_before_operational_reserve_pence: null,
      approved_payables_pending_pence: approved,
      ...fundingFields(null, args.driver_liability_pence ?? null),
      evidence_status: "PROVIDER_STUB",
      unavailable_reason: COMPANY_BALANCE_ERROR.PROVIDER_STUB_ZERO,
      source_label: "Company Balance SSOT",
      excludes_driver_wallet: true,
      sections,
    };
  }

  const statusCodeRaw = String(args?.status_code ?? "").trim() || null;
  const statusCode = statusCodeRaw === COMPANY_BALANCE_ERROR.PROVIDER_UNAVAILABLE
    || statusCodeRaw === COMPANY_BALANCE_ERROR.PROVIDER_CONNECTION_UNAVAILABLE
    ? COMPANY_BALANCE_ERROR.PROVIDER_BALANCE_UNAVAILABLE
    : statusCodeRaw;
  if (statusCode && statusCode !== "AVAILABLE") {
    const notConfigured =
      statusCode === COMPANY_BALANCE_ERROR.SOURCE_ACCOUNT_NOT_CONFIGURED
      || statusCode === COMPANY_BALANCE_ERROR.ACCOUNT_NOT_CONFIGURED;
    const sections = buildSections({
      currency,
      provider: null,
      driver_liability_pence: args?.driver_liability_pence ?? null,
      driver_payout_reserved_pence: args?.driver_payout_reserved_pence ?? null,
      approved,
      operational_reserve_pence: args?.operational_reserve_pence ?? null,
      available: null,
      provider_reason: statusCode,
      notConfigured,
    });
    return {
      status: "UNAVAILABLE",
      status_code: statusCode as CompanyBalanceStatusCode,
      currency,
      service_area_id,
      generated_at,
      last_verified_at: null,
      last_provider_sync_at: args?.last_provider_sync_at ?? null,
      source_account_id: args?.source_account_id ?? null,
      source_account_label: args?.source_account_label ?? null,
      connection_status: (statusCode as CompanyBalanceStatusCode),
      connection_health: connectionHealthFromCode(statusCode),
      company_ledger_balance_pence: null,
      provider_cash_balance_pence: null,
      provider_current_balance_pence: null,
      provider_available_balance_pence: null,
      driver_liability_pence: args?.driver_liability_pence ?? null,
      driver_payout_reserved_pence: args?.driver_payout_reserved_pence ?? null,
      customer_refund_reserved_pence: args?.customer_refund_reserved_pence ?? null,
      approved_company_payables_pence: approved,
      operational_reserve_pence: args?.operational_reserve_pence ?? null,
      company_available_for_transfer_pence: null,
      company_available_before_operational_reserve_pence: null,
      approved_payables_pending_pence: approved,
      ...fundingFields(null, args?.driver_liability_pence ?? null),
      evidence_status: statusCode as CompanyBalanceEvidenceStatus,
      unavailable_reason: statusCode,
      source_label: "Company Balance SSOT / Revolut Business",
      excludes_driver_wallet: true,
      sections,
    };
  }

  const ledger = args?.company_ledger_balance_pence ?? null;
  const provider = args?.provider_available_balance_pence
    ?? args?.provider_cash_balance_pence
    ?? null;
  const current = args?.provider_current_balance_pence ?? provider;

  if (ledger == null && provider == null) {
    const reason = COMPANY_BALANCE_ERROR.SOURCE_ACCOUNT_NOT_CONFIGURED;
    const sections = buildSections({
      currency,
      provider: null,
      driver_liability_pence: args?.driver_liability_pence ?? null,
      driver_payout_reserved_pence: args?.driver_payout_reserved_pence ?? null,
      approved,
      operational_reserve_pence: args?.operational_reserve_pence ?? null,
      available: null,
      provider_reason: reason,
      notConfigured: true,
    });
    return {
      status: "UNAVAILABLE",
      status_code: reason,
      currency,
      service_area_id,
      generated_at,
      last_verified_at: null,
      last_provider_sync_at: null,
      source_account_id: args?.source_account_id ?? null,
      source_account_label: args?.source_account_label ?? null,
      connection_status: "SOURCE_ACCOUNT_NOT_CONFIGURED",
      connection_health: "NOT_CONFIGURED",
      company_ledger_balance_pence: null,
      provider_cash_balance_pence: null,
      provider_current_balance_pence: null,
      provider_available_balance_pence: null,
      driver_liability_pence: args?.driver_liability_pence ?? null,
      driver_payout_reserved_pence: args?.driver_payout_reserved_pence ?? null,
      customer_refund_reserved_pence: args?.customer_refund_reserved_pence ?? null,
      approved_company_payables_pence: approved,
      operational_reserve_pence: args?.operational_reserve_pence ?? null,
      company_available_for_transfer_pence: null,
      company_available_before_operational_reserve_pence: null,
      approved_payables_pending_pence: approved,
      ...fundingFields(null, args?.driver_liability_pence ?? null),
      evidence_status: "NO_CANONICAL_SOURCE",
      unavailable_reason: reason,
      source_label: "Company Balance SSOT",
      excludes_driver_wallet: true,
      sections,
    };
  }

  const beforeReserve = computeCompanyAvailableBeforeOperationalReservePence({
    provider_available_balance_pence: provider,
    driver_liability_pence: args?.driver_liability_pence,
    customer_refund_reserved_pence: args?.customer_refund_reserved_pence,
    approved_company_payables_pence: approved,
  });
  const classified = args?.classified_company_cash_pence ?? null;
  const availableRaw = computeCompanyAvailableForTransferPence({
    provider_available_balance_pence: provider,
    driver_liability_pence: args?.driver_liability_pence,
    driver_payout_reserved_pence: args?.driver_payout_reserved_pence,
    customer_refund_reserved_pence: args?.customer_refund_reserved_pence,
    approved_company_payables_pence: approved,
    operational_reserve_pence: args?.operational_reserve_pence,
    classified_company_cash_pence: classified,
  });
  const available = capCompanyTransferableFundsPence({
    amount_pence: availableRaw,
    provider_available_balance_pence: provider,
    before_operational_reserve_pence: beforeReserve,
  });
  const reserveMissing = args?.operational_reserve_pence == null;
  const classifiedMissing = classified == null;
  const transferableBaseRaw = !classifiedMissing && beforeReserve != null
    ? Math.min(beforeReserve, classified)
    : null;
  const transferableBase = capCompanyTransferableFundsPence({
    amount_pence: transferableBaseRaw,
    provider_available_balance_pence: provider,
    before_operational_reserve_pence: beforeReserve,
  });
  const underprotection = evaluateCompanyFundsUnderprotection({
    provider_available_balance_pence: provider,
    protected_driver_liabilities_pence: args?.driver_liability_pence ?? null,
    approved_company_payables_pence: approved,
  });
  let beforeReserveOut = beforeReserve;
  let availableOut = available;
  if (underprotection.underprotected) {
    beforeReserveOut = 0;
    availableOut = 0;
  }
  const reserveReason = String(args?.operational_reserve_reason_code ?? "").trim()
    || OPERATIONAL_RESERVE_ERROR.NOT_CONFIGURED;
  const reserveSectionStatus =
    reserveReason === OPERATIONAL_RESERVE_ERROR.QUERY_FAILED
      || reserveReason === OPERATIONAL_RESERVE_ERROR.INVALID
      || reserveReason === OPERATIONAL_RESERVE_ERROR.CURRENCY_MISMATCH
      || reserveReason === OPERATIONAL_RESERVE_ERROR.SERVICE_AREA_MISMATCH
      || reserveReason === OPERATIONAL_RESERVE_ERROR.STALE
      ? "ERROR"
      : "NOT_CONFIGURED";

  const sections = buildSections({
    currency,
    provider,
    driver_liability_pence: args?.driver_liability_pence ?? null,
    driver_payout_reserved_pence: args?.driver_payout_reserved_pence ?? null,
    approved,
    operational_reserve_pence: args?.operational_reserve_pence ?? null,
    available: availableOut,
  });
  if (underprotection.underprotected) {
    sections.company_transfer_available = {
      status: "AVAILABLE",
      amount_pence: 0,
      currency,
      reason_code: underprotection.reason_code,
    };
  } else if (reserveMissing && sections.operational_reserve.amount_pence == null) {
    sections.operational_reserve = {
      status: reserveSectionStatus,
      amount_pence: null,
      currency,
      reason_code: reserveReason,
    };
  }
  if (!underprotection.underprotected && reserveMissing) {
    sections.company_transfer_available = {
      status: "UNAVAILABLE",
      amount_pence: null,
      currency,
      reason_code: reserveReason,
    };
  } else if (!underprotection.underprotected && classifiedMissing) {
    sections.company_transfer_available = {
      status: "UNAVAILABLE",
      amount_pence: null,
      currency,
      reason_code: OPERATIONAL_RESERVE_ERROR.CLASSIFIED_CASH_UNAVAILABLE,
    };
  }

  return {
    status: "LIVE",
    status_code: "AVAILABLE",
    currency,
    service_area_id,
    generated_at,
    last_verified_at: generated_at,
    last_provider_sync_at: args?.last_provider_sync_at ?? generated_at,
    source_account_id: args?.source_account_id ?? null,
    source_account_label: args?.source_account_label ?? "Revolut Business",
    connection_status: "AVAILABLE",
    connection_health: "AVAILABLE",
    // Legacy mirror of provider cash — never label this as ONECAB Company Balance in UI.
    company_ledger_balance_pence: ledger ?? provider,
    provider_cash_balance_pence: provider,
    provider_current_balance_pence: current,
    provider_available_balance_pence: provider,
    driver_liability_pence: args?.driver_liability_pence ?? null,
    driver_payout_reserved_pence: args?.driver_payout_reserved_pence ?? null,
    customer_refund_reserved_pence: args?.customer_refund_reserved_pence ?? null,
    approved_company_payables_pence: approved,
    operational_reserve_pence: args?.operational_reserve_pence ?? null,
    company_available_for_transfer_pence: availableOut,
    final_company_available_pence: availableOut,
    company_available_before_operational_reserve_pence: beforeReserveOut,
    classified_company_cash_pence: classified,
    transferable_base_pence: transferableBase,
    approved_payables_pending_pence: approved,
    ...fundingFields(provider, args?.driver_liability_pence ?? null),
    company_funds_underprotected: underprotection.underprotected,
    company_funds_underprotected_reason_code: underprotection.reason_code,
    company_funds_underprotected_message: underprotection.message,
    company_funds_underprotected_shortfall_pence: underprotection.shortfall_pence,
    evidence_status: "CONFIRMED",
    unavailable_reason: null,
    source_label: "Company Balance SSOT / Revolut Business",
    excludes_driver_wallet: true,
    sections,
  };
}

/** Display helper — never coerce unavailable to £0. */
export function formatCompanyBalancePence(
  pence: number | null | undefined,
  unavailableReason: string | null | undefined,
): { kind: "amount"; pence: number } | { kind: "unavailable"; reason: string } {
  if (pence == null || unavailableReason) {
    return {
      kind: "unavailable",
      reason: unavailableReason ?? COMPANY_BALANCE_ERROR.SOURCE_UNAVAILABLE,
    };
  }
  return { kind: "amount", pence };
}

export function assertCompanyTransferFundingAvailable(args: {
  money_source: string;
  company_balance: CompanyBalanceSnapshot;
  amount_pence?: number | null;
}): void {
  const source = String(args.money_source ?? "").toUpperCase();
  if (source === "DRIVER_WALLET" || source === "DRIVER_WALLET_AVAILABLE") {
    throw new Error(COMPANY_BALANCE_ERROR.FORBIDDEN_DRIVER_WALLET);
  }
  if (source !== "COMPANY_BALANCE" && source !== "APPROVED_COMPANY_PAYABLE") {
    throw new Error(COMPANY_BALANCE_ERROR.FUNDING_UNAVAILABLE);
  }
  // Slice 10: only final_company_available / company_available_for_transfer (never source/gross).
  const finalAvailable = args.company_balance.final_company_available_pence
    ?? args.company_balance.company_available_for_transfer_pence;
  if (args.company_balance.status === "UNAVAILABLE" || finalAvailable == null) {
    const reserveReason = args.company_balance.sections?.company_transfer_available?.reason_code
      ?? args.company_balance.sections?.operational_reserve?.reason_code
      ?? null;
    // Surface reserve-gate codes; other unavailable reasons collapse to FUNDING_UNAVAILABLE.
    if (
      reserveReason
      && (
        reserveReason.startsWith("OPERATIONAL_RESERVE_")
        || reserveReason === OPERATIONAL_RESERVE_ERROR.CLASSIFIED_CASH_UNAVAILABLE
        || reserveReason === OPERATIONAL_RESERVE_ERROR.TRANSFER_BLOCKED
      )
    ) {
      throw new Error(reserveReason);
    }
    throw new Error(COMPANY_BALANCE_ERROR.FUNDING_UNAVAILABLE);
  }
  const amount = args.amount_pence == null ? null : Number(args.amount_pence);
  if (amount != null && amount > finalAvailable) {
    throw new Error(COMPANY_BALANCE_ERROR.FUNDING_UNAVAILABLE);
  }
}

export function assertCompanyBalanceExcludesDriverWallet(args: {
  company_available_for_transfer_pence: number | null;
  driver_wallet_total_pence: number | null;
  driver_available_pence: number | null;
}): boolean {
  const company = args.company_available_for_transfer_pence;
  if (company == null) return true;
  if (args.driver_wallet_total_pence != null && company === args.driver_wallet_total_pence) {
    return false;
  }
  if (args.driver_available_pence != null && company === args.driver_available_pence) {
    return false;
  }
  return true;
}
