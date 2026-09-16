/**
 * Credit health vs payout eligibility — display-only separation.
 * FROZEN = credit/balance freeze only. Payout holds (e.g. payouts_enabled=false)
 * must not be labelled as missing money or "Automatic payout frozen".
 */
export type DriverWalletPayoutStatusInput = {
  wallet_status?: string | null;
  driver_credit_status?: string | null;
  wallet_variance_pence?: number | null;
  expected_payable_pence?: number | null;
  actual_wallet_trip_credits_pence?: number | null;
  wallet_balance_pence?: number | null;
  payout_blocked?: boolean;
  payouts_enabled?: boolean | null;
  reconciliation_reasons?: string[] | null;
};

export type DriverWalletPayoutStatusDisplay = {
  creditOk: boolean;
  creditFrozen: boolean;
  payoutBlocked: boolean;
  payoutBlockReason: string | null;
  showPayoutFrozenBadge: boolean;
  showPayoutHoldBadge: boolean;
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
  const payoutBlocked = driver.payout_blocked === true || driver.payouts_enabled === false;
  const payoutHoldReasons = (driver.reconciliation_reasons ?? []).filter(Boolean);
  const payoutBlockReason = payoutBlocked
    ? (driver.payouts_enabled === false
      ? 'Driver payouts disabled'
      : payoutHoldReasons[0] ?? 'Payout eligibility hold')
    : null;
  // Never show "Automatic payout frozen" from credit-OK + verification alone.
  const showPayoutFrozenBadge = creditFrozen || (payoutBlocked && !creditOk);
  const showPayoutHoldBadge = payoutBlocked && creditOk && !creditFrozen;
  return {
    creditOk,
    creditFrozen,
    payoutBlocked,
    payoutBlockReason,
    showPayoutFrozenBadge,
    showPayoutHoldBadge,
  };
}
