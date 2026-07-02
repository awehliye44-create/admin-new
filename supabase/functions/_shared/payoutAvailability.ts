/**
 * ONECAB Payout Availability — guards and ledger balance helpers.
 *
 * NON-NEGOTIABLE: available_payout / finance_cleared / scheduled / cash-out
 * must NOT be derived as max(wallet_balance, 0). Use driverWalletPayoutSSOT
 * and payoutEligibilitySSOT for payout amounts.
 */

import {
  computeLedgerWalletBalancePence,
  type LedgerRow,
} from "./onecabFinanceLedger.ts";
import { computePayoutEligibility } from "./payoutEligibilitySSOT.ts";

export const WALLET_NEGATIVE_BLOCK_CODE = "WALLET_BALANCE_NEGATIVE";
export const WALLET_NEGATIVE_BLOCK_REASON =
  "Wallet balance is negative — driver owes ONECAB. All payouts blocked until balance reaches zero.";

export const PAYOUT_EXCEEDS_AVAILABLE_BLOCK_CODE = "PAYOUT_EXCEEDS_AVAILABLE";
export const PAYOUT_EXCEEDS_AVAILABLE_BLOCK_REASON =
  "Requested payout amount exceeds finance-cleared eligible payout.";

/**
 * @deprecated Do not use for payout/cashout display. wallet_balance is accounting liability only.
 * Use finance_cleared_amount_pence / eligible_payout_pence from driverWalletPayoutSSOT.
 */
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
  financeClearedPence?: number | null;
  stripeSettledUnpaidPence?: number | null;
  inFlightPayoutPence?: number | null;
  payoutBlocked?: boolean;
}): PayoutGuardResult {
  const wb = args.walletBalancePence;
  const eligibility = computePayoutEligibility({
    walletUnpaidPence: Math.max(0, wb),
    stripeSettledUnpaidPence: Math.max(0, args.stripeSettledUnpaidPence ?? args.financeClearedPence ?? 0),
    payoutBlocked: args.payoutBlocked ?? wb < 0,
    inFlightPayoutPence: args.inFlightPayoutPence ?? 0,
  });
  const available = eligibility.eligible_payout_pence;
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
