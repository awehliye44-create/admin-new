import type { PerDriverFinanceSSOT } from '@/hooks/usePerDriverFinancialReconciliation';

/** Shown when Pay Driver Now is blocked due to zero SSOT available balance. */
export const MANUAL_PAYOUT_NO_SSOT_BALANCE_MESSAGE =
  'Manual payout unavailable. Driver has no positive SSOT available balance after cash commission recovery.';

/** Amber warning when soft reconciliation warnings are present — payout still allowed. */
export const MANUAL_PAYOUT_SOFT_WARNING_MESSAGE =
  'Finance review warning present. Payout amount is still capped by Stripe available balance.';

export type ManualPayoutDriverFlags = {
  stripe_account_id?: string | null;
  onboarding_complete?: boolean | null;
  payouts_enabled?: boolean | null;
};

export type ManualPayoutSsotSnapshot = {
  settled_card_earnings_pence: number;
  outstanding_cash_commission_pence: number;
  available_now_pence: number;
  payout_eligibility_status: string;
};

const WALLET_NEGATIVE_BLOCK_MESSAGE =
  'Wallet balance is negative — driver owes ONECAB. All payouts blocked until balance reaches zero.';

export function hasSoftPayoutWarning(
  ssot: Pick<PerDriverFinanceSSOT, 'payout_warning_reasons'>,
): boolean {
  return (ssot.payout_warning_reasons?.length ?? 0) > 0;
}

export function formatPayoutEligibilityStatus(args: {
  driver: ManualPayoutDriverFlags;
  ssot: Pick<
    PerDriverFinanceSSOT,
    | 'payout_blocked'
    | 'ledger_sync_missing'
    | 'driver_available_now_pence'
    | 'driver_wallet_balance_pence'
    | 'driver_debt_pence'
    | 'payout_warning_reasons'
    | 'reconciliation_status'
  >;
  inFlightPayout?: boolean;
}): string {
  const { driver, ssot } = args;
  const connected = Boolean(driver.stripe_account_id) && Boolean(driver.onboarding_complete);

  if (!connected) return 'Not Connected';
  if (!driver.payouts_enabled) return 'Connected — Payout Not Enabled';
  if (ssot.ledger_sync_missing) return 'Blocked — Ledger Sync Missing';
  if ((ssot.driver_wallet_balance_pence ?? 0) < 0) return 'Blocked — Driver In Debt';
  if (ssot.payout_blocked) return 'Blocked — Payout Hold';
  if (args.inFlightPayout) return 'Blocked — Payout In Flight';
  if (ssot.driver_available_now_pence <= 0) {
    return 'Connected — No SSOT Available Balance';
  }
  if (hasSoftPayoutWarning(ssot)) return 'Eligible — Finance Review Warning';
  return 'Eligible';
}

/** Hard blocks only — soft reconciliation warnings do not disable payout. */
export function canManualPayout(args: {
  driver: ManualPayoutDriverFlags;
  ssot: PerDriverFinanceSSOT;
  inFlightPayout?: boolean;
}): boolean {
  const { driver, ssot } = args;
  const connected = Boolean(driver.stripe_account_id) && Boolean(driver.onboarding_complete);
  const payoutEligible = connected && Boolean(driver.payouts_enabled);

  return (
    payoutEligible &&
    (ssot.driver_wallet_balance_pence ?? 0) >= 0 &&
    !ssot.payout_blocked &&
    !ssot.ledger_sync_missing &&
    !args.inFlightPayout &&
    ssot.driver_available_now_pence > 0
  );
}

export function buildManualPayoutSsotSnapshot(args: {
  driver: ManualPayoutDriverFlags;
  ssot: PerDriverFinanceSSOT;
  settled_card_earnings_pence: number;
  outstanding_cash_commission_pence: number;
  inFlightPayout?: boolean;
}): ManualPayoutSsotSnapshot {
  return {
    settled_card_earnings_pence: args.settled_card_earnings_pence,
    outstanding_cash_commission_pence: args.outstanding_cash_commission_pence,
    available_now_pence: args.ssot.driver_available_now_pence,
    payout_eligibility_status: formatPayoutEligibilityStatus({
      driver: args.driver,
      ssot: args.ssot,
      inFlightPayout: args.inFlightPayout,
    }),
  };
}

export function manualPayoutBlockedHeadline(args: {
  ssot: PerDriverFinanceSSOT;
  canPayout: boolean;
  inFlightPayout?: boolean;
}): string | null {
  if (args.canPayout) return null;
  if (args.inFlightPayout) {
    return 'Manual payout unavailable. A payout is already in flight for this driver.';
  }
  if ((args.ssot.driver_wallet_balance_pence ?? 0) < 0) {
    return WALLET_NEGATIVE_BLOCK_MESSAGE;
  }
  if (args.ssot.driver_available_now_pence <= 0) {
    return MANUAL_PAYOUT_NO_SSOT_BALANCE_MESSAGE;
  }
  return 'Manual payout unavailable. Resolve hard payout blocks before paying out.';
}

export function manualPayoutSoftWarningMessage(ssot: PerDriverFinanceSSOT): string | null {
  if (!hasSoftPayoutWarning(ssot)) return null;
  const reasons = ssot.payout_warning_reasons?.join(' · ');
  return reasons
    ? `${MANUAL_PAYOUT_SOFT_WARNING_MESSAGE} (${reasons})`
    : MANUAL_PAYOUT_SOFT_WARNING_MESSAGE;
}
