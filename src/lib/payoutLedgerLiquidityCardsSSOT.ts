/**
 * Payout Ledger Company Funding overview — liquidity card display SSOT (UI only).
 * Accounting / revenue cards (net commission, unclassified cash) must not render here.
 */

export const PAYOUT_LEDGER_LIQUIDITY_CARD_TITLES = {
  REVOLUT_SOURCE_ACCOUNT_BALANCE: "Revolut Source Account Balance",
  PROTECTED_DRIVER_LIABILITIES: "Protected Driver Liabilities",
  RESERVED_DRIVER_PAYOUTS: "Reserved Driver Payouts",
  ONECAB_FUNDS_BEFORE_RESERVE: "ONECAB Funds Before Reserve",
  OPERATIONAL_REFUND_RESERVE: "Operational / Refund Reserve",
  ONECAB_REAL_AVAILABLE_FUNDS: "ONECAB Real Available Funds",
} as const;

export const PAYOUT_LEDGER_LIQUIDITY_SECTION_TITLE = "Liquidity & protection";

/** Display tooltips for liquidity cards (UI-only; avoids backend label churn). */
export const PAYOUT_LEDGER_LIQUIDITY_CARD_TOOLTIPS = {
  REVOLUT_SOURCE_ACCOUNT_BALANCE:
    "Total available cash in the selected Revolut Business account. This includes protected driver and company liabilities.",
  PROTECTED_DRIVER_LIABILITIES:
    "Driver money protected from company use. Shown separately from company spendable funds.",
  RESERVED_DRIVER_PAYOUTS:
    "Display-only: ACTIVE driver_payout_reservations. Included in Protected Driver Liabilities when computing company funds.",
  ONECAB_FUNDS_BEFORE_RESERVE:
    "ONECAB-owned liquidity before operational reserve: Revolut source − protected driver liabilities − approved company payables (− customer refund reserve when configured).",
  OPERATIONAL_REFUND_RESERVE:
    "Configured operational/refund reserve. NOT_CONFIGURED until an admin setting exists — never invent £0.",
  ONECAB_REAL_AVAILABLE_FUNDS:
    "Spendable company transfer budget from live Revolut liquidity after protected driver liabilities, approved payables, and operational/refund reserve. Never includes Payment Sessions commission totals. When the reserve is NOT_CONFIGURED, real available funds stay UNAVAILABLE (not silent £0).",
} as const;

/** Exact strings that must never appear on the Payout Ledger overview company-funding grid. */
export const PAYOUT_LEDGER_FORBIDDEN_ACCOUNTING_CARD_TITLES = [
  "ONECAB Net Commission Available",
  "Recognised ONECAB Net Commission",
  "Unclassified Company Cash",
] as const;

/**
 * UI-only Real Available from live liquidity (before reserve − reserve).
 * Never uses Payment Sessions / onecab_net_commission_available_pence.
 */
export function computePayoutLedgerRealAvailableFundsPence(args: {
  company_available_before_operational_reserve_pence: number | null | undefined;
  operational_reserve_pence: number | null | undefined;
  operational_reserve_configured: boolean;
  provider_available_balance_pence: number | null | undefined;
  company_funds_underprotected?: boolean;
}): number | null {
  if (args.company_funds_underprotected) return 0;
  if (args.company_available_before_operational_reserve_pence == null) return null;
  if (!args.operational_reserve_configured || args.operational_reserve_pence == null) {
    return null;
  }
  const before = Math.max(0, Math.round(args.company_available_before_operational_reserve_pence));
  const reserve = Math.max(0, Math.round(args.operational_reserve_pence));
  let available = Math.max(0, before - reserve);
  if (args.provider_available_balance_pence != null) {
    available = Math.min(available, Math.max(0, Math.round(args.provider_available_balance_pence)));
  }
  available = Math.min(available, before);
  return available;
}

export function isPayoutLedgerForbiddenAccountingTitle(title: string): boolean {
  return (PAYOUT_LEDGER_FORBIDDEN_ACCOUNTING_CARD_TITLES as readonly string[]).includes(title);
}
