import { describe, expect, it } from 'vitest';
import { buildDriverStatementPeriodTotals } from '../../../supabase/functions/_shared/driverStatementPeriodTotals.ts';

describe('buildDriverStatementPeriodTotals', () => {
  it('includes PENALTY and DEDUCTION in penalties_pence', () => {
    const totals = buildDriverStatementPeriodTotals(
      [
        {
          driver_id: 'd1',
          trip_id: 't1',
          trip_status: 'completed',
          financial_outcome: 'COMPLETED',
          gross_fare_pence: 1000,
          onecab_gross_commission_pence: 150,
          driver_net_pence: 850,
        },
      ],
      [
        { driver_id: 'd1', type: 'BONUS', amount_pence: 200 },
        { driver_id: 'd1', type: 'PENALTY', amount_pence: -50 },
        { driver_id: 'd1', type: 'DEDUCTION', amount_pence: -30 },
        { driver_id: 'd1', type: 'CASH_COMMISSION_DEBT', amount_pence: -20 },
      ],
      new Set(['d1']),
    );

    expect(totals).toHaveLength(1);
    expect(totals[0].bonuses_pence).toBe(200);
    expect(totals[0].penalties_pence).toBe(80);
    expect(totals[0].cash_collected_pence).toBe(20);
    expect(totals[0].completed_trips).toBe(1);
    expect(totals[0].no_show_trips).toBe(0);
    expect(totals[0].late_cancel_trips).toBe(0);
    expect(totals[0].net_earnings_pence).toBe(850 + 200 - 80 - 20);
  });

  it('counts no_show and late_cancel trips separately from completed', () => {
    const totals = buildDriverStatementPeriodTotals(
      [
        { driver_id: 'd1', trip_id: 't1', trip_status: 'completed', financial_outcome: 'COMPLETED', gross_fare_pence: 100 },
        { driver_id: 'd1', trip_id: 't2', trip_status: 'no_show', financial_outcome: 'NO_SHOW', gross_fare_pence: 50 },
        { driver_id: 'd1', trip_id: 't3', financial_outcome: 'LATE_PASSENGER_CANCELLATION', gross_fare_pence: 40 },
      ],
      [],
      new Set(['d1']),
    );

    expect(totals[0].completed_trips).toBe(1);
    expect(totals[0].no_show_trips).toBe(1);
    expect(totals[0].late_cancel_trips).toBe(1);
  });

  it('sums payout ledger debits into payouts_received_pence', () => {
    const totals = buildDriverStatementPeriodTotals(
      [],
      [
        { driver_id: 'd1', type: 'WEEKLY_PAYOUT', amount_pence: -1500 },
        { driver_id: 'd1', type: 'EARLY_CASHOUT', amount_pence: -300 },
      ],
      new Set(['d1']),
    );

    expect(totals).toHaveLength(1);
    expect(totals[0].payouts_received_pence).toBe(1800);
  });
});
