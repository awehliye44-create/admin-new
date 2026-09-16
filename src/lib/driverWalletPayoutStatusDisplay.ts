/**
 * Credit health vs payout eligibility — display-only separation.
 * FROZEN = credit/balance freeze only.
 * Stage C2: payout holds come from operational pause / payout_blocked / typed
 * blocking reasons — NOT legacy drivers.payouts_enabled alone.
 */
export type DriverWalletPayoutStatusInput = {
  wallet_status?: string | null;
  driver_credit_status?: string | null;
  wallet_variance_pence?: number | null;
  expected_payable_pence?: number | null;
  actual_wallet_trip_credits_pence?: number | null;
  wallet_balance_pence?: number | null;
  payout_blocked?: boolean;
  /** @deprecated Stage C2 diagnostic only — never the effective gate. */
  payouts_enabled?: boolean | null;
  payout_operational_paused?: boolean | null;
  payout_block_reason_code?: string | null;
  reconciliation_reasons?: string[] | null;
};

export type DriverWalletPayoutStatusDisplay = {
  creditOk: boolean;
  creditFrozen: boolean;
  payoutBlocked: boolean;
  payoutBlockReason: string | null;
  showPayoutFrozenBadge: boolean;
  showPayoutHoldBadge: boolean;
  /** Deprecated legacy flag for diagnostics only. */
  legacyPayoutsEnabled: boolean | null;
};

export function resolveDriverWalletPayoutStatusDisplay(
  driver: DriverWalletPayoutStatusInput,
): DriverWalletPayoutStatusDisplay {
  const creditOk = driver.driver_credit_status === 'DRIVER_CREDIT_OK'
    || (driver.wallet_variance_pence === 0
      && (driver.expected_payable_pence ?? null) != null
      && (driver.actual_wallet_trip_credits_pence ?? null) != null);
  const creditFrozen = driver.wallet_status === 'FROZEN'
    || (driver.wallet_balance_pence ?? 0) < 0
    || driver.driver_credit_status === 'DRIVER_UNDER_CREDITED'
    || driver.driver_credit_status === 'DRIVER_OVER_CREDITED';

  const operationalPaused = driver.payout_operational_paused === true;
  const payoutBlocked = driver.payout_blocked === true || operationalPaused;
  const payoutHoldReasons = (driver.reconciliation_reasons ?? []).filter(Boolean);
  let payoutBlockReason: string | null = null;
  if (payoutBlocked) {
    if (operationalPaused || driver.payout_block_reason_code === 'ADMIN_HOLD') {
      payoutBlockReason = 'Driver payouts temporarily paused';
    } else if (driver.payout_block_reason_code === 'FEATURE_DISABLED') {
      payoutBlockReason = 'Driver payouts are currently disabled';
    } else {
      payoutBlockReason = payoutHoldReasons[0] ?? 'Payout eligibility hold';
    }
  }

  const showPayoutFrozenBadge = creditFrozen || (payoutBlocked && !creditOk);
  const showPayoutHoldBadge = payoutBlocked && creditOk && !creditFrozen;
  return {
    creditOk,
    creditFrozen,
    payoutBlocked,
    payoutBlockReason,
    showPayoutFrozenBadge,
    showPayoutHoldBadge,
    legacyPayoutsEnabled: driver.payouts_enabled ?? null,
  };
}
