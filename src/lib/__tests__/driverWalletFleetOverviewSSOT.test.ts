import { describe, expect, it } from 'vitest';
import { buildDriverWalletFleetOverview } from '@/lib/driverWalletFleetOverviewSSOT';

describe('buildDriverWalletFleetOverview', () => {
  it('rolls up active SSOT balances only (no lifetime paid-out totals)', () => {
    const overview = buildDriverWalletFleetOverview([
      {
        available_for_payout_pence: 0,
        pending_balance_pence: 0,
        withdrawal_in_progress_pence: 200,
        wallet_status: 'ACTIVE',
      },
      {
        available_for_payout_pence: 0,
        pending_balance_pence: 100,
        included_in_payout_batch_amount_pence: 50,
        failed_payout_stuck_processing_pence: 25,
        debt_recovery: { remaining_debt_pence: 50 },
        wallet_status: 'ACTIVE',
      },
      {
        available_for_payout_pence: 0,
        pending_balance_pence: 0,
        wallet_status: 'FROZEN',
      },
    ]);

    expect(overview.total_drivers).toBe(3);
    expect(overview.total_available_balance_pence).toBe(0);
    expect(overview.total_pending_balance_pence).toBe(100);
    expect(overview.total_reserved_pence).toBe(250);
    expect(overview.total_processing_exception_pence).toBe(25);
    expect(overview.wallets_active).toBe(2);
    expect(overview.wallets_on_hold).toBe(1);
  });

  it('uses eligibility pending/available fields', () => {
    const overview = buildDriverWalletFleetOverview([
      {
        available_for_payout_pence: 2239,
        pending_balance_pence: 1818,
        wallet_status: 'ACTIVE',
      },
      {
        available_for_payout_pence: 773,
        pending_balance_pence: 1155,
        wallet_status: 'ACTIVE',
      },
    ]);
    expect(overview.total_available_balance_pence).toBe(3012);
    expect(overview.total_pending_balance_pence).toBe(2973);
  });

  it('returns zeros for empty fleet', () => {
    expect(buildDriverWalletFleetOverview([])).toEqual({
      total_drivers: 0,
      total_pending_balance_pence: 0,
      total_available_balance_pence: 0,
      total_reserved_pence: 0,
      total_processing_exception_pence: 0,
      wallets_active: 0,
      wallets_on_hold: 0,
    });
  });
});
