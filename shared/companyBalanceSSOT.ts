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
} as const;

export type CompanyBalanceEvidenceStatus =
  | "CONFIRMED"
  | "PARTIAL"
  | "NO_CANONICAL_SOURCE"
  | "PROVIDER_STUB"
  | "UNVERIFIED";

export type CompanyBalanceSnapshot = {
  status: "LIVE" | "PARTIAL" | "UNAVAILABLE";
  currency: string;
  service_area_id: string | null;
  generated_at: string;
  /** Internal ONECAB company ledger — null when no ledger source exists. */
  company_ledger_balance_pence: number | null;
  /** Confirmed Revolut Business / provider cash — null when not verified. */
  provider_cash_balance_pence: number | null;
  /**
   * Safe transferable amount. Null when unknown.
   * Must never equal driver wallet liabilities.
   */
  company_available_for_transfer_pence: number | null;
  approved_payables_pending_pence: number | null;
  evidence_status: CompanyBalanceEvidenceStatus;
  unavailable_reason: string | null;
  source_label: string;
  /** Explicit proof that DWL was not used. */
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
      candidate: "company_outgoing_batches",
      kind: "table",
      exists: true,
      usable_for_company_balance: false,
      notes: "Batch metadata only.",
    },
    {
      candidate: "driver_wallet_ledger",
      kind: "table",
      exists: true,
      usable_for_company_balance: false,
      notes: "Driver liability domain — forbidden as company balance.",
    },
    {
      candidate: "revolutAdapter.getBalance",
      kind: "adapter",
      exists: true,
      usable_for_company_balance: false,
      notes: "Stub returns available_pence: 0 after Merchant orders probe — must not display as £0.",
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
 * Resolve company balance from proven sources only.
 * Until a real ledger or Revolut Business cash endpoint is wired,
 * return UNAVAILABLE (never £0).
 */
export function resolveCompanyBalanceSnapshot(args?: {
  service_area_id?: string | null;
  currency?: string | null;
  company_ledger_balance_pence?: number | null;
  provider_cash_balance_pence?: number | null;
  approved_payables_pending_pence?: number | null;
  provider_balance_is_stub?: boolean;
  now?: Date;
}): CompanyBalanceSnapshot {
  const generated_at = (args?.now ?? new Date()).toISOString();
  const currency = String(args?.currency ?? "GBP").toUpperCase() || "GBP";
  const service_area_id = args?.service_area_id ?? null;

  if (args?.provider_balance_is_stub) {
    return {
      status: "UNAVAILABLE",
      currency,
      service_area_id,
      generated_at,
      company_ledger_balance_pence: null,
      provider_cash_balance_pence: null,
      company_available_for_transfer_pence: null,
      approved_payables_pending_pence: args.approved_payables_pending_pence ?? null,
      evidence_status: "PROVIDER_STUB",
      unavailable_reason: COMPANY_BALANCE_ERROR.PROVIDER_STUB_ZERO,
      source_label: "Company Balance SSOT",
      excludes_driver_wallet: true,
    };
  }

  const ledger = args?.company_ledger_balance_pence ?? null;
  const provider = args?.provider_cash_balance_pence ?? null;

  if (ledger == null && provider == null) {
    return {
      status: "UNAVAILABLE",
      currency,
      service_area_id,
      generated_at,
      company_ledger_balance_pence: null,
      provider_cash_balance_pence: null,
      company_available_for_transfer_pence: null,
      approved_payables_pending_pence: args?.approved_payables_pending_pence ?? null,
      evidence_status: "NO_CANONICAL_SOURCE",
      unavailable_reason: COMPANY_BALANCE_ERROR.SOURCE_UNAVAILABLE,
      source_label: "Company Balance SSOT",
      excludes_driver_wallet: true,
    };
  }

  // Safe transferable = min of confirmed sources when both present; else the one confirmed source.
  let available: number | null = null;
  if (ledger != null && provider != null) available = Math.min(ledger, provider);
  else if (ledger != null) available = ledger;
  else if (provider != null) available = provider;

  return {
    status: ledger != null && provider != null ? "LIVE" : "PARTIAL",
    currency,
    service_area_id,
    generated_at,
    company_ledger_balance_pence: ledger,
    provider_cash_balance_pence: provider,
    company_available_for_transfer_pence: available,
    approved_payables_pending_pence: args?.approved_payables_pending_pence ?? null,
    evidence_status: ledger != null && provider != null ? "CONFIRMED" : "PARTIAL",
    unavailable_reason: null,
    source_label: "Company Balance SSOT",
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

/**
 * Funding gate for company transfers — never allow company-balance spend
 * when the company balance source is unavailable.
 */
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

/** Guard: driver wallet pence must never be copied into company available. */
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
