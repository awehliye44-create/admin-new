/** Admin presentation-only helpers; not part of Edge uploads. */
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
} from "../../supabase/functions/_shared/onecabFinanceLedger.ts";

import {
  computeAvailableCashOutPence,
  computeManualBankAvailablePence,
  isManualBankPayoutProviderName,
} from "../../supabase/functions/_shared/driverWalletPayoutSSOT.ts";

import {
  FR_EXPECTED_STAMP_STATUS,
  sumFrDriverExpectedEntitlementPence,
  type FrDriverSettlementTripForReconciliation,
} from "../../supabase/functions/_shared/frDriverExpectedEntitlementSSOT.ts";
import { FrDriverReconciliationStatus, FrDriverAuditOverviewCounts, FrDriverCreditStatus, FrPayoutReconciliationStatus } from "../../supabase/functions/_shared/frDriverReconciliationSSOT.ts";


/** Aggregate per-driver statuses — no cross-driver amount netting. */
export function aggregateFrDriverAuditOverview(
  rows: Array<{ reconciliation_status: FrDriverReconciliationStatus }>,
  args?: { settlementIdentityBalanced?: boolean },
): FrDriverAuditOverviewCounts {
  let balanced = 0;
  let walletMismatch = 0;
  let payoutMismatch = 0;
  let providerUnavailable = 0;
  let pendingSync = 0;

  for (const row of rows) {
    const s = row.reconciliation_status;
    const credit = (row as { driver_credit_status?: FrDriverCreditStatus }).driver_credit_status;
    const payout = (row as { payout_status?: FrPayoutReconciliationStatus }).payout_status;
    if (s === "BALANCED") balanced += 1;
    if (
      s === "DRIVER_WALLET_MISMATCH"
      || s === "DRIVER_AND_PAYOUT_MISMATCH"
      || s === "MISSING_WALLET_EVIDENCE"
      || credit === "DRIVER_UNDER_CREDITED"
      || credit === "DRIVER_OVER_CREDITED"
      || credit === "EXPECTED_STAMP_MISSING"
    ) {
      walletMismatch += 1;
    }
    if (
      s === "PAYOUT_MISMATCH"
      || s === "DRIVER_AND_PAYOUT_MISMATCH"
      || payout === "PAYOUT_MISMATCH"
    ) {
      payoutMismatch += 1;
    }
    if (s === "PROVIDER_BALANCE_UNAVAILABLE") providerUnavailable += 1;
    if (
      s === "PENDING_SYNC"
      || s === "MISSING_SETTLEMENT_EVIDENCE"
      || s === "ACCOUNT_UNVERIFIED"
    ) {
      pendingSync += 1;
    }
  }

  const audited = rows.length;
  const mismatchAny = walletMismatch > 0 || payoutMismatch > 0;
  const incomplete = pendingSync > 0 || providerUnavailable > 0;
  const settlementOk = args?.settlementIdentityBalanced === true;

  let overview: FrDriverAuditOverviewCounts["overview_driver_audit_status"];
  if (audited === 0) {
    overview = "SETTLEMENT_BALANCED_DRIVER_AUDIT_PENDING";
  } else if (mismatchAny) {
    overview = "DRIVER_AUDIT_MISMATCH";
  } else if (incomplete) {
    overview = settlementOk
      ? "SETTLEMENT_BALANCED_DRIVER_AUDIT_PENDING"
      : "PARTIAL";
  } else if (balanced === audited) {
    overview = "BALANCED";
  } else {
    overview = "PARTIAL";
  }

  return {
    drivers_balanced_count: balanced,
    driver_wallet_mismatches_count: walletMismatch,
    payout_mismatches_count: payoutMismatch,
    provider_balance_unavailable_count: providerUnavailable,
    pending_sync_count: pendingSync,
    drivers_audited_count: audited,
    driver_audit_complete: audited > 0 && !incomplete && !mismatchAny,
    overview_driver_audit_status: overview,
  };
}
