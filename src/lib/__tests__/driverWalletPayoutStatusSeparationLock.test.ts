import { describe, expect, it } from 'vitest';

/**
 * UI lock: credit health and payout eligibility stay separate.
 * Credit-OK + payouts disabled must not show "wallet mismatch" freeze copy.
 */
describe('DriverWalletOverviewCards payout status separation', () => {
  function resolveBadges(driver: {
    wallet_status?: string | null;
    driver_credit_status?: string | null;
    wallet_variance_pence?: number | null;
    expected_payable_pence?: number | null;
    actual_wallet_trip_credits_pence?: number | null;
    wallet_balance_pence?: number | null;
    payout_blocked?: boolean;
    payouts_enabled?: boolean | null;
    reconciliation_reasons?: string[];
  }) {
    const creditOk = driver.driver_credit_status === 'DRIVER_CREDIT_OK'
      || (driver.wallet_variance_pence === 0
        && (driver.expected_payable_pence ?? null) != null
        && (driver.actual_wallet_trip_credits_pence ?? null) != null);
    const creditFrozen = driver.wallet_status === 'FROZEN'
      || (driver.wallet_balance_pence ?? 0) < 0
      || driver.driver_credit_status === 'DRIVER_UNDER_CREDITED'
      || driver.driver_credit_status === 'DRIVER_OVER_CREDITED';
    const payoutBlocked = driver.payout_blocked === true || driver.payouts_enabled === false;
    const payoutBlockReason = payoutBlocked
      ? (driver.payouts_enabled === false
        ? 'Driver payouts disabled'
        : (driver.reconciliation_reasons ?? [])[0] ?? 'Payout eligibility hold')
      : null;
    const showPayoutFrozenBadge = creditFrozen || (payoutBlocked && !creditOk);
    const showPayoutHoldBadge = payoutBlocked && creditOk && !creditFrozen;
    return { creditOk, creditFrozen, showPayoutFrozenBadge, showPayoutHoldBadge, payoutBlockReason };
  }

  it('F4: credit-OK + payouts disabled → hold reason, not freeze/mismatch', () => {
    const r = resolveBadges({
      wallet_status: 'RESTRICTED',
      driver_credit_status: 'DRIVER_CREDIT_OK',
      wallet_variance_pence: 0,
      expected_payable_pence: 3319,
      actual_wallet_trip_credits_pence: 3319,
      wallet_balance_pence: 3319,
      payout_blocked: true,
      payouts_enabled: false,
    });
    expect(r.creditOk).toBe(true);
    expect(r.creditFrozen).toBe(false);
    expect(r.showPayoutFrozenBadge).toBe(false);
    expect(r.showPayoutHoldBadge).toBe(true);
    expect(r.payoutBlockReason).toBe('Driver payouts disabled');
  });

  it('F4: under-credited → freeze badge', () => {
    const r = resolveBadges({
      wallet_status: 'FROZEN',
      driver_credit_status: 'DRIVER_UNDER_CREDITED',
      wallet_variance_pence: -100,
      expected_payable_pence: 525,
      actual_wallet_trip_credits_pence: 425,
      wallet_balance_pence: 425,
      payout_blocked: false,
      payouts_enabled: true,
    });
    expect(r.showPayoutFrozenBadge).toBe(true);
    expect(r.showPayoutHoldBadge).toBe(false);
  });

  it('F4: credit-OK without payout blocker → no frozen badge', () => {
    const r = resolveBadges({
      wallet_status: 'ACTIVE',
      driver_credit_status: 'DRIVER_CREDIT_OK',
      wallet_variance_pence: 0,
      expected_payable_pence: 1000,
      actual_wallet_trip_credits_pence: 1000,
      wallet_balance_pence: 1000,
      payout_blocked: false,
      payouts_enabled: true,
    });
    expect(r.showPayoutFrozenBadge).toBe(false);
    expect(r.showPayoutHoldBadge).toBe(false);
  });
});
