import { describe, expect, it } from 'vitest';
import {
  buildDriverWalletPeriodSummary,
  buildDriverWalletSummaryResponse,
  isLedgerRowInPeriod,
} from '@/lib/driverWalletPeriodWidgetsSSOT';
import { resolveFinancePeriodBounds } from '@/lib/financePeriodFilter';

describe('driverWalletPeriodWidgetsSSOT (backend DTO parity)', () => {
  it('aggregates period ledger totals without React money invention', () => {
    const summary = buildDriverWalletPeriodSummary({
      periodFrom: '2026-07-10T00:00:00.000Z',
      periodTo: '2026-07-10T23:59:59.999Z',
      ledger: [
        { type: 'TRIP_EARNING_NET', amount_pence: 408, related_trip_id: 't1', created_at: '2026-07-10T12:00:00Z' },
        { type: 'TRIP_EARNING_NET', amount_pence: 500, related_trip_id: 't2', created_at: '2026-07-10T13:00:00Z' },
        { type: 'PLATFORM_COMMISSION', amount_pence: 102, related_trip_id: 't1', created_at: '2026-07-10T12:00:00Z' },
        { type: 'BONUS', amount_pence: 50, created_at: '2026-07-10T14:00:00Z' },
        { type: 'WEEKLY_PAYOUT', amount_pence: -200, created_at: '2026-07-10T15:00:00Z' },
        { type: 'TRIP_EARNING_NET', amount_pence: 999, related_trip_id: 'old', created_at: '2026-06-01T12:00:00Z' },
      ],
      tripCommissionSnapshots: [
        { trip_id: 't1', completed_at: '2026-07-10T11:00:00Z', commission_pence: 102 },
        { trip_id: 't2', completed_at: '2026-07-10T12:00:00Z', commission_pence: 125 },
      ],
    });

    expect(summary.trip_credit_pence).toBe(908);
    expect(summary.driver_net_earnings_pence).toBe(908);
    expect(summary.paid_trip_count).toBe(2);
    expect(summary.platform_commission_pence).toBe(227);
    expect(summary.bonus_pence).toBe(50);
    expect(summary.payout_debit_pence).toBe(200);
    expect(summary.net_wallet_movement_pence).toBe(408 + 500 + 50 - 200);
  });

  it('empty period zeros while account balances stay live', () => {
    const res = buildDriverWalletSummaryResponse({
      periodKey: 'today',
      periodFrom: '2026-07-11T00:00:00.000Z',
      periodTo: '2026-07-11T23:59:59.999Z',
      account: {
        live_balance_pence: 1058,
        available_balance_pence: 1058,
        pending_balance_pence: 0,
        outstanding_debt_pence: 0,
        annual_driver_earnings_pence: 2000,
      },
      ledger: [
        { type: 'TRIP_EARNING_NET', amount_pence: 500, related_trip_id: 'old', created_at: '2026-07-01T10:00:00Z' },
      ],
    });
    expect(res.summary.trip_credit_pence).toBe(0);
    expect(res.summary.paid_trip_count).toBe(0);
    expect(res.account.live_balance_pence).toBe(1058);
    expect(res.account.annual_driver_earnings_pence).toBe(2000);
  });

  it('provider fee must not reduce driver net or net wallet movement', () => {
    const summary = buildDriverWalletPeriodSummary({
      periodFrom: '2026-07-10T00:00:00.000Z',
      periodTo: '2026-07-10T23:59:59.999Z',
      ledger: [
        { type: 'TRIP_EARNING_NET', amount_pence: 408, related_trip_id: 't1', created_at: '2026-07-10T12:00:00Z' },
        { type: 'PAYMENT_PROVIDER_FEE', amount_pence: -27, created_at: '2026-07-10T12:00:00Z' },
      ],
      tripCommissionSnapshots: [
        { trip_id: 't1', completed_at: '2026-07-10T11:00:00Z', commission_pence: 102 },
      ],
    });
    expect(summary.driver_net_earnings_pence).toBe(408);
    expect(summary.net_wallet_movement_pence).toBe(408);
    expect(summary.platform_commission_pence).toBe(102);
  });

  it('live update after completed trip credit increases period + account live balance', () => {
    const accountBefore = {
      live_balance_pence: 572,
      available_balance_pence: 572,
      pending_balance_pence: 0,
      outstanding_debt_pence: 0,
      annual_driver_earnings_pence: 0,
    };
    const ledgerBefore = [
      { type: 'TRIP_EARNING_NET', amount_pence: 572, related_trip_id: 't0', created_at: '2026-07-08T10:00:00Z' },
    ];
    const before = buildDriverWalletSummaryResponse({
      periodKey: 'week',
      periodFrom: '2026-07-07T00:00:00.000Z',
      periodTo: '2026-07-13T23:59:59.999Z',
      account: accountBefore,
      ledger: ledgerBefore,
      tripCommissionSnapshots: [
        { trip_id: 't0', completed_at: '2026-07-08T09:00:00Z', commission_pence: 100 },
      ],
    });

    const afterCredit = buildDriverWalletSummaryResponse({
      periodKey: 'week',
      periodFrom: '2026-07-07T00:00:00.000Z',
      periodTo: '2026-07-13T23:59:59.999Z',
      account: {
        live_balance_pence: 572 + 486,
        available_balance_pence: 572 + 486,
        pending_balance_pence: 0,
        outstanding_debt_pence: 0,
        annual_driver_earnings_pence: 0,
      },
      ledger: [
        ...ledgerBefore,
        { type: 'TRIP_EARNING_NET', amount_pence: 486, related_trip_id: 't1', created_at: '2026-07-10T12:00:00Z' },
      ],
      tripCommissionSnapshots: [
        { trip_id: 't0', completed_at: '2026-07-08T09:00:00Z', commission_pence: 100 },
        { trip_id: 't1', completed_at: '2026-07-10T11:00:00Z', commission_pence: 86 },
      ],
    });

    expect(before.summary.trip_credit_pence).toBe(572);
    expect(afterCredit.summary.trip_credit_pence).toBe(1058);
    expect(afterCredit.summary.paid_trip_count).toBe(2);
    expect(afterCredit.summary.platform_commission_pence).toBe(186);
    expect(afterCredit.account.live_balance_pence).toBe(1058);
    expect(afterCredit.summary.net_wallet_movement_pence - before.summary.net_wallet_movement_pence).toBe(486);
  });
});

describe('finance period / timezone (Europe/London)', () => {
  it('Today / This Week / Custom use London day bounds', () => {
    const now = new Date('2026-07-10T15:30:00.000Z'); // Friday afternoon UTC
    const today = resolveFinancePeriodBounds('today', undefined, undefined, now);
    expect(today.label).toContain('Today');
    expect(today.label).toContain('London');
    expect(isLedgerRowInPeriod('2026-07-10T12:00:00Z', today.from, today.to)).toBe(true);

    const week = resolveFinancePeriodBounds('week', undefined, undefined, now);
    expect(week.label).toContain('This week');
    expect(isLedgerRowInPeriod('2026-07-06T12:00:00Z', week.from, week.to)).toBe(true); // Mon
    expect(isLedgerRowInPeriod('2026-07-05T12:00:00Z', week.from, week.to)).toBe(false); // Sun prior

    const custom = resolveFinancePeriodBounds(
      'custom',
      new Date('2026-07-01T12:00:00Z'),
      new Date('2026-07-03T12:00:00Z'),
      now,
    );
    expect(custom.label).toContain('Custom');
    expect(isLedgerRowInPeriod('2026-07-02T12:00:00Z', custom.from, custom.to)).toBe(true);
    expect(isLedgerRowInPeriod('2026-07-04T12:00:00Z', custom.from, custom.to)).toBe(false);
  });

  it('changing period does not invent account balances (account is separate SSOT)', () => {
    const account = {
      live_balance_pence: 1058,
      available_balance_pence: 1058,
      pending_balance_pence: 0,
      outstanding_debt_pence: 0,
      annual_driver_earnings_pence: 0,
    };
    const today = buildDriverWalletSummaryResponse({
      periodKey: 'today',
      periodFrom: '2026-07-11T00:00:00.000Z',
      periodTo: '2026-07-11T23:59:59.999Z',
      account,
      ledger: [],
    });
    const week = buildDriverWalletSummaryResponse({
      periodKey: 'week',
      periodFrom: '2026-07-07T00:00:00.000Z',
      periodTo: '2026-07-13T23:59:59.999Z',
      account,
      ledger: [
        { type: 'TRIP_EARNING_NET', amount_pence: 986, related_trip_id: 't1', created_at: '2026-07-08T10:00:00Z' },
      ],
    });
    expect(today.account.live_balance_pence).toBe(week.account.live_balance_pence);
    expect(today.summary.trip_credit_pence).toBe(0);
    expect(week.summary.trip_credit_pence).toBe(986);
  });
});
