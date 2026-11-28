/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Financial Reconciliation SSOT — audit/reconcile engine.
 *
 * Payment Sessions owns customer payment amounts (authorised / captured / released /
 * refunded / fees). FR consumes those values and must never invent or recalculate them.
 *
 * Other canonical sources:
 * - trips (commission, driver earnings)
 * - driver_wallet_ledger (paid out, adjustments)
 * - provider balance API (digital positions only)
 */

import { computeLedgerWalletBalancePence } from "../../../functions/_shared/onecabFinanceLedger.ts";

import { excludeTripFromPlatformCollectedFinance } from "../../../functions/_shared/commissionWalletSSOT.ts";
import { netCustomerRevenuePence, RECONCILIATION_VARIANCE_TOLERANCE_PENCE } from "../../../functions/_shared/financialReconciliationSSOT.ts";


/**
 * @deprecated Phase 3A.4 — trip-based liability inflated earnings.
 * Use perDriverLedgerLiabilityPence() for allocation, reconciliation, and payout gating.
 */
export function perDriverRemainingLiabilityPence(args: {
  driverNetEarningsPence: number;
  bankPaidOutPence: number;
  completedEarlyCashoutsPence: number;
  adjustmentsPence: number;
}): number {
  return Math.max(
    0,
    args.driverNetEarningsPence -
      args.bankPaidOutPence -
      args.completedEarlyCashoutsPence +
      args.adjustmentsPence,
  );
}


export function buildTripEarningsReconciliationCheck(args: {
  netCustomerRevenuePence: number;
  driverNetEarningsPence: number;
  onecabGrossCommissionPence: number;
  tipsPence: number;
  tolerancePence?: number;
}) {
  const rhs = args.driverNetEarningsPence + args.onecabGrossCommissionPence + args.tipsPence;
  const variance = args.netCustomerRevenuePence - rhs;
  const tolerance = args.tolerancePence ?? RECONCILIATION_VARIANCE_TOLERANCE_PENCE;
  const balanced = Math.abs(variance) <= tolerance;
  return {
    net_customer_revenue_pence: args.netCustomerRevenuePence,
    driver_net_earnings_pence: args.driverNetEarningsPence,
    onecab_gross_commission_pence: args.onecabGrossCommissionPence,
    tips_pence: args.tipsPence,
    expected_sum_pence: rhs,
    variance_pence: variance,
    delta_pence: variance,
    balanced,
    status: balanced ? ("BALANCED" as const) : ("RECONCILIATION_MISMATCH" as const),
  };
}

export * from "../../../functions/_shared/financialReconciliationSSOT.ts";
