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
export const WALLET_NEGATIVE_BLOCK_REASON =
  "Wallet balance is negative — driver owes ONECAB. All payouts blocked until balance reaches zero.";

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

