/**
 * ONECAB Payout Availability — SINGLE SOURCE OF TRUTH.
 *
 * Authoritative formulas (do not duplicate elsewhere):
 *
 *   wallet_balance   = sum(driver_wallet_ledger excluding reporting-only types)
 *   available_payout = max(wallet_balance, 0)
 *   driver_debt      = abs(min(wallet_balance, 0))
 *
 * Payout rules enforced here:
 *   1. wallet_balance < 0          → BLOCK all payouts (weekly, instant, admin).
 *   2. requested > available_payout → BLOCK.
 *
 * Every payout path (admin manual, weekly Monday settlement, instant cashout,
 * retries) MUST evaluate `evaluatePayoutGuard(...)` before any provider call
 * or ledger debit. No other "available" formula exists in the codebase.
 */

import {
  computeLedgerWalletBalancePence,
  type LedgerRow,
} from "./onecabFinanceLedger.ts";

export const WALLET_NEGATIVE_BLOCK_CODE = "WALLET_BALANCE_NEGATIVE";
export const WALLET_NEGATIVE_BLOCK_REASON =
  "Wallet balance is negative — driver owes ONECAB. All payouts blocked until balance reaches zero.";

export const PAYOUT_EXCEEDS_AVAILABLE_BLOCK_CODE = "PAYOUT_EXCEEDS_AVAILABLE";
export const PAYOUT_EXCEEDS_AVAILABLE_BLOCK_REASON =
  "Requested payout amount exceeds available payout (max wallet_balance, 0).";

/** Authoritative: available payout = max(walletBalance, 0). The ONLY availability formula. */
export function availablePayoutPence(walletBalancePence: number): number {
  return Math.max(0, walletBalancePence);
}

/** Authoritative: debt = abs(min(walletBalance, 0)). */
export function driverDebtPence(walletBalancePence: number): number {
  return Math.max(0, -walletBalancePence);
}

/** Signed wallet balance from raw ledger rows (excludes reporting-only types). */
export function walletBalanceFromLedger(ledger: LedgerRow[]): number {
  return computeLedgerWalletBalancePence(ledger);
}

export type PayoutGuardResult = {
  allowed: boolean;
  wallet_balance_pence: number;
  available_payout_pence: number;
  driver_debt_pence: number;
  requested_pence: number | null;
  block_codes: string[];
  block_reasons: string[];
};

/**
 * Evaluate payout guard for ANY payout path.
 * Pass `requestedPence` to enforce the payout-limit rule; omit to check wallet sign only.
 */
export function evaluatePayoutGuard(args: {
  walletBalancePence: number;
  requestedPence?: number | null;
}): PayoutGuardResult {
  const wb = args.walletBalancePence;
  const available = availablePayoutPence(wb);
  const debt = driverDebtPence(wb);
  const requested = typeof args.requestedPence === "number" ? args.requestedPence : null;

  const codes: string[] = [];
  const reasons: string[] = [];

  if (wb < 0) {
    codes.push(WALLET_NEGATIVE_BLOCK_CODE);
    reasons.push(WALLET_NEGATIVE_BLOCK_REASON);
  }
  if (requested !== null && requested > available) {
    codes.push(PAYOUT_EXCEEDS_AVAILABLE_BLOCK_CODE);
    reasons.push(PAYOUT_EXCEEDS_AVAILABLE_BLOCK_REASON);
  }

  return {
    allowed: codes.length === 0,
    wallet_balance_pence: wb,
    available_payout_pence: available,
    driver_debt_pence: debt,
    requested_pence: requested,
    block_codes: codes,
    block_reasons: reasons,
  };
}
