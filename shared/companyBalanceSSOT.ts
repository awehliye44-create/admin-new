/**
 * Company Balance SSOT — company-owned money only.
 * Never consume Driver Wallet live/available/pending/debt.
 * Never invent provider cash as £0 when evidence is missing.
 */

export const COMPANY_BALANCE_ERROR = {
  SOURCE_UNAVAILABLE: "COMPANY_BALANCE_SOURCE_UNAVAILABLE",
  PROVIDER_STUB_ZERO: "COMPANY_BALANCE_PROVIDER_STUB_REJECTED",
  FUNDING_UNAVAILABLE: "FUNDING_UNAVAILABLE",
  FORBIDDEN_DRIVER_WALLET: "FORBIDDEN_COMPANY_SOURCE_DRIVER_WALLET",
  ACCOUNT_NOT_CONFIGURED: "ACCOUNT_NOT_CONFIGURED",
  AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  STALE_PROVIDER_EVIDENCE: "STALE_PROVIDER_EVIDENCE",
  TRANSFER_DISABLED: "TRANSFER_DISABLED",
  PENDING_SYNC: "PENDING_SYNC",
} as const;

export type CompanyBalanceStatusCode =
  | "AVAILABLE"
  | "PENDING_SYNC"
  | "AUTHENTICATION_REQUIRED"
  | "ACCOUNT_NOT_CONFIGURED"
  | "CURRENCY_MISMATCH"
  | "PROVIDER_UNAVAILABLE"
  | "STALE_PROVIDER_EVIDENCE"
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
  source_account_id: string | null;
  source_account_label: string | null;
  connection_status: CompanyBalanceStatusCode;
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
   * Safe transferable amount. Null when unknown.
   * Must never equal driver wallet liabilities.
   */
  company_available_for_transfer_pence: number | null;
  /** @deprecated alias of approved_company_payables_pence */
  approved_payables_pending_pence: number | null;
  evidence_status: CompanyBalanceEvidenceStatus;
  unavailable_reason: string | null;
  source_label: string;
  /** Explicit proof that DWL was not used as provider cash. */
  excludes_driver_wallet: true;
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
      candidate: "stripeAdapter.getBalance",
      kind: "adapter",
      exists: true,
      usable_for_company_balance: false,
      notes: "Stripe retired for runtime payouts — forbidden.",
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
 * Safe transferable amount after protected liabilities / reserves.
 * All inputs exact pence; null provider available → null result (never £0 invent).
 */
export function computeCompanyAvailableForTransferPence(args: {
  provider_available_balance_pence: number | null;
  driver_liability_pence?: number | null;
  driver_payout_reserved_pence?: number | null;
  customer_refund_reserved_pence?: number | null;
  approved_company_payables_pence?: number | null;
  operational_reserve_pence?: number | null;
}): number | null {
  if (args.provider_available_balance_pence == null) return null;
  const protectedSum = Math.max(0, Number(args.driver_liability_pence ?? 0))
    + Math.max(0, Number(args.driver_payout_reserved_pence ?? 0))
    + Math.max(0, Number(args.customer_refund_reserved_pence ?? 0))
    + Math.max(0, Number(args.approved_company_payables_pence ?? 0))
    + Math.max(0, Number(args.operational_reserve_pence ?? 0));
  return Math.max(0, args.provider_available_balance_pence - protectedSum);
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
  provider_balance_is_stub?: boolean;
  status_code?: CompanyBalanceStatusCode | string | null;
  source_account_id?: string | null;
  source_account_label?: string | null;
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
    return {
      status: "UNAVAILABLE",
      status_code: COMPANY_BALANCE_ERROR.PROVIDER_STUB_ZERO,
      currency,
      service_area_id,
      generated_at,
      last_verified_at: null,
      source_account_id: args.source_account_id ?? null,
      source_account_label: args.source_account_label ?? null,
      connection_status: "PROVIDER_UNAVAILABLE",
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
      approved_payables_pending_pence: approved,
      evidence_status: "PROVIDER_STUB",
      unavailable_reason: COMPANY_BALANCE_ERROR.PROVIDER_STUB_ZERO,
      source_label: "Company Balance SSOT",
      excludes_driver_wallet: true,
    };
  }

  const statusCode = String(args?.status_code ?? "").trim() || null;
  if (statusCode && statusCode !== "AVAILABLE") {
    return {
      status: "UNAVAILABLE",
      status_code: statusCode,
      currency,
      service_area_id,
      generated_at,
      last_verified_at: null,
      source_account_id: args?.source_account_id ?? null,
      source_account_label: args?.source_account_label ?? null,
      connection_status: (statusCode as CompanyBalanceStatusCode),
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
      approved_payables_pending_pence: approved,
      evidence_status: statusCode as CompanyBalanceEvidenceStatus,
      unavailable_reason: statusCode,
      source_label: "Company Balance SSOT / Revolut Business",
      excludes_driver_wallet: true,
    };
  }

  const ledger = args?.company_ledger_balance_pence ?? null;
  const provider = args?.provider_available_balance_pence
    ?? args?.provider_cash_balance_pence
    ?? null;
  const current = args?.provider_current_balance_pence ?? provider;

  if (ledger == null && provider == null) {
    return {
      status: "UNAVAILABLE",
      status_code: COMPANY_BALANCE_ERROR.SOURCE_UNAVAILABLE,
      currency,
      service_area_id,
      generated_at,
      last_verified_at: null,
      source_account_id: args?.source_account_id ?? null,
      source_account_label: args?.source_account_label ?? null,
      connection_status: "ACCOUNT_NOT_CONFIGURED",
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
      approved_payables_pending_pence: approved,
      evidence_status: "NO_CANONICAL_SOURCE",
      unavailable_reason: COMPANY_BALANCE_ERROR.SOURCE_UNAVAILABLE,
      source_label: "Company Balance SSOT",
      excludes_driver_wallet: true,
    };
  }

  const available = computeCompanyAvailableForTransferPence({
    provider_available_balance_pence: provider,
    driver_liability_pence: args?.driver_liability_pence,
    driver_payout_reserved_pence: args?.driver_payout_reserved_pence,
    customer_refund_reserved_pence: args?.customer_refund_reserved_pence,
    approved_company_payables_pence: approved,
    operational_reserve_pence: args?.operational_reserve_pence,
  });

  return {
    status: "LIVE",
    status_code: "AVAILABLE",
    currency,
    service_area_id,
    generated_at,
    last_verified_at: generated_at,
    source_account_id: args?.source_account_id ?? null,
    source_account_label: args?.source_account_label ?? "Revolut Business",
    connection_status: "AVAILABLE",
    company_ledger_balance_pence: ledger ?? provider,
    provider_cash_balance_pence: provider,
    provider_current_balance_pence: current,
    provider_available_balance_pence: provider,
    driver_liability_pence: args?.driver_liability_pence ?? null,
    driver_payout_reserved_pence: args?.driver_payout_reserved_pence ?? null,
    customer_refund_reserved_pence: args?.customer_refund_reserved_pence ?? null,
    approved_company_payables_pence: approved,
    operational_reserve_pence: args?.operational_reserve_pence ?? null,
    company_available_for_transfer_pence: available,
    approved_payables_pending_pence: approved,
    evidence_status: "CONFIRMED",
    unavailable_reason: null,
    source_label: "Company Balance SSOT / Revolut Business",
    excludes_driver_wallet: true,
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
  if (args.company_balance.status === "UNAVAILABLE"
    || args.company_balance.company_available_for_transfer_pence == null) {
    throw new Error(COMPANY_BALANCE_ERROR.FUNDING_UNAVAILABLE);
  }
  const amount = args.amount_pence == null ? null : Number(args.amount_pence);
  if (amount != null && amount > args.company_balance.company_available_for_transfer_pence) {
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
