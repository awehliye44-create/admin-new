import { describe, expect, it } from 'vitest';
import { buildDriverWalletFleetOverview } from '@/lib/driverWalletFleetOverviewSSOT';

describe('buildDriverWalletFleetOverview', () => {
  it('rolls up SSOT driver rows for Level 1 overview cards', () => {
    const overview = buildDriverWalletFleetOverview([
      {
        wallet_balance_pence: 986,
        cashout_limit_pence: 0,
        wallet_status: 'ACTIVE',
        period_kpis: { pending_earnings_pence: 0, outstanding_debt_pence: 0 },
      },
      {
        wallet_balance_pence: 408,
        cashout_limit_pence: 0,
        wallet_status: 'ACTIVE',
        period_kpis: { pending_earnings_pence: 100 },
        debt_recovery: { remaining_debt_pence: 50 },
      },
      {
        wallet_balance_pence: -25,
        cashout_limit_pence: 0,
        wallet_status: 'FROZEN',
        period_kpis: { pending_earnings_pence: 0 },
      },
    ]);

    expect(overview.total_drivers).toBe(3);
    expect(overview.total_live_balance_pence).toBe(986 + 408 - 25);
    expect(overview.total_available_balance_pence).toBe(0);
    expect(overview.total_pending_balance_pence).toBe(100);
    expect(overview.total_outstanding_debt_pence).toBe(50);
    expect(overview.wallets_active).toBe(2);
    expect(overview.wallets_on_hold).toBe(1);
    expect(overview.negative_wallets).toBe(1);
  });

  it('returns zeros for empty fleet', () => {
    expect(buildDriverWalletFleetOverview([])).toEqual({
      total_drivers: 0,
      total_live_balance_pence: 0,
      total_available_balance_pence: 0,
      total_pending_balance_pence: 0,
      total_outstanding_debt_pence: 0,
      wallets_active: 0,
      wallets_on_hold: 0,
      negative_wallets: 0,
    });
  });
});
