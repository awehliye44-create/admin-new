/**
 * A8B28F Stage C companion DRAFT — manualPayoutGate.ts
 * Stop treating drivers.payouts_enabled as pause/onboarding completeness.
 */

export type ManualPayoutDriverFlagsStageC = {
  payout_operational_paused?: boolean | null;
  provider_verified_active_destination?: boolean | null;
  /** @deprecated ignored for readiness */
  payouts_enabled?: boolean | null;
  provider_account_id?: string | null;
  onboarding_complete?: boolean | null;
};

export function isDriverPayoutReadyStageC(driver: ManualPayoutDriverFlagsStageC): boolean {
  return (
    driver.payout_operational_paused !== true &&
    driver.provider_verified_active_destination === true
  );
}

export function formatPayoutEligibilityStatusStageC(args: {
  driver: ManualPayoutDriverFlagsStageC;
  ssot: {
    payout_blocked?: boolean;
    ledger_sync_missing?: boolean;
    driver_available_now_pence: number;
    driver_wallet_balance_pence?: number;
    payout_warning_reasons?: string[];
  };
  inFlightPayout?: boolean;
}): string {
  const { driver, ssot } = args;
  if (driver.payout_operational_paused === true) return 'Payouts Paused';
  if (driver.provider_verified_active_destination !== true) {
    return 'Payout Account Unverified';
  }
  if (ssot.ledger_sync_missing) return 'Blocked — Ledger Sync Missing';
  if ((ssot.driver_wallet_balance_pence ?? 0) < 0) return 'Blocked — Driver In Debt';
  if (ssot.payout_blocked) return 'Blocked — Payout Hold';
  if (args.inFlightPayout) return 'Blocked — Payout In Flight';
  if (ssot.driver_available_now_pence <= 0) return 'No SSOT Available Balance';
  if ((ssot.payout_warning_reasons?.length ?? 0) > 0) return 'Eligible — Finance Review Warning';
  return 'Eligible';
}

export function canManualPayoutStageC(args: {
  driver: ManualPayoutDriverFlagsStageC;
  ssot: {
    payout_blocked: boolean;
    ledger_sync_missing: boolean;
    driver_available_now_pence: number;
    driver_wallet_balance_pence?: number;
  };
  inFlightPayout?: boolean;
}): boolean {
  return (
    isDriverPayoutReadyStageC(args.driver) &&
    (args.ssot.driver_wallet_balance_pence ?? 0) >= 0 &&
    !args.ssot.payout_blocked &&
    !args.ssot.ledger_sync_missing &&
    !args.inFlightPayout &&
    args.ssot.driver_available_now_pence > 0
  );
}
