import { describe, expect, it } from 'vitest';
import {
  displayDriverWalletSsotBalances,
  mergeDriverWalletEligibilityOverlay,
} from '@/lib/driverWalletSsotBalances';

describe('displayDriverWalletSsotBalances', () => {
  it('prefers eligibility pending/available over cashout_limit and period KPI', () => {
    const balances = displayDriverWalletSsotBalances({
      wallet_balance_pence: 2239,
      cashout_limit_pence: 2239,
      available_for_payout_pence: 0,
      pending_balance_pence: 1818,
      period_kpis: { pending_earnings_pence: 0 },
    });
    expect(balances).toEqual({
      livePence: 2239,
      availablePence: 0,
      pendingPence: 1818,
      withdrawalInProgressPence: 0,
    });
  });

  it('does not treat live as available when overlay is missing', () => {
    const balances = displayDriverWalletSsotBalances({
      wallet_balance_pence: 773,
      cashout_limit_pence: 773,
      period_kpis: { pending_earnings_pence: 0 },
    });
    expect(balances.livePence).toBe(773);
    expect(balances.availablePence).toBe(773);
    expect(balances.pendingPence).toBe(0);
  });
});

describe('mergeDriverWalletEligibilityOverlay', () => {
  it('overlays SQL eligibility onto an old Edge snapshot that showed Available = Live and Pending = 0', () => {
    const merged = mergeDriverWalletEligibilityOverlay(
      {
        driver_id: 'mk0001',
        wallet_balance_pence: 2239,
        cashout_limit_pence: 2239,
        period_kpis: { pending_earnings_pence: 0, outstanding_debt_pence: 0 },
      },
      {
        driver_id: 'mk0001',
        available_balance_pence: 2239,
        pending_balance_pence: 1818,
        withdrawal_in_progress_pence: 0,
      },
    );
    expect(merged.pending_balance_pence).toBe(1818);
    expect(merged.available_for_payout_pence).toBe(2239);
    expect(merged.cashout_limit_pence).toBe(2239);
    expect(merged.period_kpis?.pending_earnings_pence).toBe(1818);
    expect(displayDriverWalletSsotBalances(merged).pendingPence).toBe(1818);
  });
});
