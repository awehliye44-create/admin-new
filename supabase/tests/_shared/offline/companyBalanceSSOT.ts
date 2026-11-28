/** Offline test/audit-only helpers; not part of Edge uploads. */
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
} from "../../../functions/_shared/companyOperationalReserveSSOT.ts";

import {
  COMPANY_FUNDS_UNDERPROTECTED,
  evaluateCompanyFundsUnderprotection,
} from "../../../functions/_shared/companyFundsUnderprotectionSSOT.ts";
import { CompanyBalanceSourceAudit, capCompanyTransferableFundsPence, COMPANY_BALANCE_ERROR, CompanyBalanceSnapshot } from "../../../functions/_shared/companyBalanceSSOT.ts";


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

export * from "../../../functions/_shared/companyBalanceSSOT.ts";
