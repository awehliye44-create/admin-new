import { describe, expect, it } from 'vitest';
import {
  attachDriverWalletRunningBalances,
  attachRunningBalancesNewestFirst,
} from '@/lib/driverWalletRunningBalanceSSOT';
import {
  applyInstantCashoutPolicy,
  applyPayoutControlCentrePolicy,
  parsePayoutControlCentreSettings,
} from '../../../supabase/functions/_shared/payoutControlCentreSettingsSSOT.ts';

describe('driverWalletRunningBalanceSSOT', () => {
  it('attaches chronological balance-after without filtered-subset reset', () => {
    const rows = attachDriverWalletRunningBalances([
      { id: '1', created_at: '2026-01-01T10:00:00Z', amount_pence: 1000 },
      { id: '2', created_at: '2026-01-01T11:00:00Z', amount_pence: -150 },
      { id: '3', created_at: '2026-01-01T12:00:00Z', amount_pence: 200 },
    ]);
    expect(rows.map((r) => r.running_balance_pence)).toEqual([1000, 850, 1050]);
  });

  it('preserves newest-first display order', () => {
    const newestFirst = [
      { id: '3', created_at: '2026-01-01T12:00:00Z', amount_pence: 200 },
      { id: '2', created_at: '2026-01-01T11:00:00Z', amount_pence: -150 },
      { id: '1', created_at: '2026-01-01T10:00:00Z', amount_pence: 1000 },
    ];
    const out = attachRunningBalancesNewestFirst(newestFirst, 0);
    expect(out[0].id).toBe('3');
    expect(out[0].running_balance_pence).toBe(1050);
    expect(out[2].running_balance_pence).toBe(1000);
  });
});

describe('payoutControlCentreSettingsSSOT', () => {
  it('blocks when payouts disabled and caps max', () => {
    const settings = parsePayoutControlCentreSettings({
      payouts_enabled: 'false',
      payout_max_pence: 5000,
    });
    const disabled = applyPayoutControlCentrePolicy(8000, settings, { wallet_balance_pence: 8000 });
    expect(disabled.allowed).toBe(false);
    expect(disabled.reasons).toContain('PAYOUTS_DISABLED');

    const enabled = parsePayoutControlCentreSettings({
      payouts_enabled: true,
      payout_min_pence: 100,
      payout_max_pence: 5000,
      payout_rule_negative_wallet: 'block',
    });
    const capped = applyPayoutControlCentrePolicy(8000, enabled, { wallet_balance_pence: 8000 });
    expect(capped.allowed).toBe(true);
    expect(capped.amount_pence).toBe(5000);
  });

  it('enforces instant cash-out min/max/day', () => {
    const settings = parsePayoutControlCentreSettings({
      early_cashout_min_pence: 500,
      early_cashout_max_pence: 2000,
      early_cashout_max_per_day: 1,
      early_cashout_fee_pence: 100,
    });
    expect(applyInstantCashoutPolicy(400, settings, 0).allowed).toBe(false);
    expect(applyInstantCashoutPolicy(2500, settings, 0).allowed).toBe(false);
    expect(applyInstantCashoutPolicy(1000, settings, 1).allowed).toBe(false);
    expect(applyInstantCashoutPolicy(1000, settings, 0).allowed).toBe(true);
  });
});
