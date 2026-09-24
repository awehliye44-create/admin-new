/**
 * Visibility + menu ordering for Driver Wallet Ledger Review & repair.
 * Opening the control never mutates.
 */
import {
  DRIVER_FINANCIAL_REPAIR_COPY,
  shouldShowDriverFinancialReviewRepair,
  type DriverFinancialRepairVisibilityInput,
} from '../../shared/driverFinancialReviewRepairSSOT';

export type DriverWalletLedgerRowMenuItem =
  | 'open_wallet_account'
  | 'review_and_repair'
  | 'adjustment';

export function resolveDriverWalletLedgerRowMenu(args: {
  visibility: DriverFinancialRepairVisibilityInput;
  payout_operational_paused?: boolean | null;
  adjustmentsDeployed?: boolean;
}): DriverWalletLedgerRowMenuItem[] {
  const items: DriverWalletLedgerRowMenuItem[] = ['open_wallet_account'];

  if (shouldShowDriverFinancialReviewRepair(args.visibility)) {
    items.push('review_and_repair');
  }

  if (args.adjustmentsDeployed !== false) {
    items.push('adjustment');
  }

  // Resume/Pause is rendered by DriverOperationalPauseMenuItem (Resume only when paused).
  void args.payout_operational_paused;

  return items;
}

export function driverFinancialReviewRepairButtonLabel(): string {
  return DRIVER_FINANCIAL_REPAIR_COPY.BUTTON;
}
