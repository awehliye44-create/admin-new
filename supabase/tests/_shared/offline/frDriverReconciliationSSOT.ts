/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Financial Reconciliation — per-driver wallet vs payable invariants (audit only).
 *
 * Hard rules:
 * - Driver Wallet Ledger owns wallet balance.
 * - Provider Account Balance is reference-only (never reconciliation truth).
 * - No cross-driver netting.
 * - Unknown is never zero for classification / display of provider balance.
 *
 * Same-scope rules (FR must not invent mismatches):
 * - Period payable variance = period TEN credits − period expected stamps.
 *   Payout / cashout debits are excluded from that variance.
 * - Live wallet balance / available / pending are informational (Wallet / Payout pages).
 *   They must never drive DRIVER_WALLET_MISMATCH by themselves.
 * - Pending 27h credits and post-payout TEN rows are not payout mismatches.
 */

import {
  BALANCE_EXCLUDED_LEDGER_TYPES,
  computeLedgerWalletBalancePence,
} from "../../../functions/_shared/onecabFinanceLedger.ts";

import {
  computeAvailableCashOutPence,
  computeManualBankAvailablePence,
  isManualBankPayoutProviderName,
} from "../../../functions/_shared/driverWalletPayoutSSOT.ts";

import {
  FR_EXPECTED_STAMP_STATUS,
  sumFrDriverExpectedEntitlementPence,
  type FrDriverSettlementTripForReconciliation,
} from "../../../functions/_shared/frDriverExpectedEntitlementSSOT.ts";
import { FR_TRIP_ENTITLEMENT_CREDIT_TYPES, FrDriverSettlementTrip } from "../../../functions/_shared/frDriverReconciliationSSOT.ts";


export function isFrTripEntitlementCreditType(type: string | null | undefined): boolean {
  return FR_TRIP_ENTITLEMENT_CREDIT_TYPES.has(String(type ?? "").toUpperCase());
}


export function sumExpectedPayablePence(trips: FrDriverSettlementTrip[]): number | null {
  return sumFrDriverExpectedEntitlementPence(trips).expected_payable_pence;
}


/** Live wallet balance is never the FR reconciliation-status input. */
export function frReconciliationStatusIgnoresLiveWalletBalance(): true {
  return true;
}

export * from "../../../functions/_shared/frDriverReconciliationSSOT.ts";
export * from "../../../../shared/edgePresentation/frDriverReconciliationSSOT.ts";
