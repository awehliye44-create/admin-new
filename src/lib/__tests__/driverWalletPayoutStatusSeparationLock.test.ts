import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveDriverWalletPayoutStatusDisplay } from '../driverWalletPayoutStatusDisplay';

/**
 * UI lock: credit health and payout eligibility stay separate.
 * Credit-OK + payouts disabled must not show "wallet mismatch" freeze copy.
 */
describe('Driver wallet payout status separation', () => {
  it('F4: credit-OK + payouts disabled → hold reason, not freeze/mismatch', () => {
    const r = resolveDriverWalletPayoutStatusDisplay({
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
    const r = resolveDriverWalletPayoutStatusDisplay({
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
    const r = resolveDriverWalletPayoutStatusDisplay({
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

  it('F4: live wallet surfaces import shared status display SSOT', () => {
    const root = resolve(__dirname, '../..');
    for (const rel of [
      'components/finance/DriverWalletActivePositionCards.tsx',
      'components/finance/DriverWalletAccountHeader.tsx',
      'components/finance/DriverWalletDriverList.tsx',
      'components/finance/DriverWalletOverviewCards.tsx',
    ]) {
      const src = readFileSync(resolve(root, rel), 'utf8');
      expect(src).toContain('resolveDriverWalletPayoutStatusDisplay');
      expect(src).not.toMatch(/wallet mismatch/i);
    }
  });
});
