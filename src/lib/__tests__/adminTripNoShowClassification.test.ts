import { describe, expect, it } from 'vitest';
import {
  MISSED_CANCELLED_STATUSES,
  adminNoShowPaymentLabel,
  adminNoShowStatusLabel,
  adminTripHistoryDisplayAt,
  belongsInMissedCancelled,
  belongsInTripHistory,
  isAdminNoShowTrip,
} from '../adminTripNoShowClassification';
import {
  TRIP_HISTORY_FINANCIAL_OUTCOMES,
  TRIP_HISTORY_STATUSES,
  tripHistoryDateOrFilter,
  sortTripHistoryRows,
  tripHistoryTerminalOrFilter,
} from '../tripHistoryQuery';

/** MK-260824-002 production shape (read-only fixture). */
const MK_260824_002 = {
  trip_code: 'MK-260824-002',
  status: 'no_show',
  financial_outcome: 'NO_SHOW',
  no_show_charge_pence: 400,
  capture_amount_pence: 400,
  provider_fee_pence: 24,
  driver_net_pence: 376,
  commission_pence: 0,
  completed_at: null as string | null,
  cancelled_at: '2026-08-24T11:49:19.055Z',
  created_at: '2026-08-24T11:40:00.000Z',
  ps_captured_pence: 400,
};

describe('admin NO_SHOW page ownership', () => {
  it('classifies MK-260824-002 as no-show for Trip History only', () => {
    expect(isAdminNoShowTrip(MK_260824_002)).toBe(true);
    expect(belongsInTripHistory(MK_260824_002)).toBe(true);
    expect(belongsInMissedCancelled(MK_260824_002)).toBe(false);
    expect(adminNoShowStatusLabel(MK_260824_002)).toBe('No-show');
    expect(adminNoShowPaymentLabel(MK_260824_002)).toBe('No-show fee captured');
    expect(adminTripHistoryDisplayAt(MK_260824_002)).toBe(MK_260824_002.cancelled_at);
  });

  it('shows No-show - no charge when nothing was captured', () => {
    const row = {
      status: 'no_show',
      financial_outcome: 'NO_SHOW',
      no_show_charge_pence: 0,
      capture_amount_pence: 0,
      ps_captured_pence: 0,
    };
    expect(adminNoShowPaymentLabel(row)).toBe('No-show - no charge');
    expect(belongsInMissedCancelled(row)).toBe(false);
    expect(belongsInTripHistory(row)).toBe(true);
  });

  it('excludes no-show by financial_outcome / charge even if status is cancelled', () => {
    expect(
      belongsInMissedCancelled({
        status: 'cancelled',
        financial_outcome: 'NO_SHOW',
      }),
    ).toBe(false);
    expect(
      belongsInMissedCancelled({
        status: 'cancelled',
        no_show_charge_pence: 400,
      }),
    ).toBe(false);
    expect(
      belongsInMissedCancelled({
        status: 'customer_cancelled',
        terminal_reason: 'no_show',
      }),
    ).toBe(false);
  });

  it('keeps normal customer cancellation in Missed & Cancelled only', () => {
    const row = {
      status: 'customer_cancelled',
      financial_outcome: null,
      no_show_charge_pence: 0,
    };
    expect(belongsInMissedCancelled(row)).toBe(true);
    expect(belongsInTripHistory(row)).toBe(false);
    expect(adminNoShowStatusLabel(row)).toBeNull();
  });

  it('keeps driver cancellation (status cancelled) in Missed & Cancelled', () => {
    const row = {
      status: 'cancelled',
      financial_outcome: null,
      no_show_charge_pence: 0,
      special_instructions: 'Driver cancelled',
    };
    expect(belongsInMissedCancelled(row)).toBe(true);
    expect(isAdminNoShowTrip(row)).toBe(false);
  });

  it('keeps completed normal trip in Trip History', () => {
    const row = {
      status: 'completed',
      financial_outcome: 'COMPLETED',
      completed_at: '2026-08-24T12:00:00.000Z',
    };
    expect(belongsInTripHistory(row)).toBe(true);
    expect(belongsInMissedCancelled(row)).toBe(false);
    expect(adminNoShowPaymentLabel(row)).toBeNull();
  });

  it('Missed & Cancelled status list never includes no_show', () => {
    expect(MISSED_CANCELLED_STATUSES).not.toContain('no_show');
    expect([...MISSED_CANCELLED_STATUSES]).toEqual([
      'cancelled',
      'customer_cancelled',
      'missed',
      'expired',
    ]);
  });

  it('Trip History terminal filter still includes no_show / NO_SHOW', () => {
    expect(TRIP_HISTORY_STATUSES).toContain('no_show');
    expect(TRIP_HISTORY_FINANCIAL_OUTCOMES).toContain('NO_SHOW');
    const filter = tripHistoryTerminalOrFilter();
    expect(filter).toContain('no_show');
    expect(filter).toContain('NO_SHOW');
  });

  it('Trip History date filter includes no-show without completed_at via cancelled_at', () => {
    const start = new Date('2026-08-24T00:00:00.000Z');
    const end = new Date('2026-08-24T23:59:59.999Z');
    const filter = tripHistoryDateOrFilter(start, end);
    expect(filter).toContain('completed_at.gte.');
    expect(filter).toContain('status.eq.no_show');
    expect(filter).toContain('financial_outcome.eq.NO_SHOW');
    expect(filter).toContain('cancelled_at.gte.');
    expect(filter).toContain('completed_at.is.null');
  });
});

describe('trip history ordering', () => {
  it('keeps no-show rows (completed_at NULL) in newest-first order', () => {
    const rows = [
      { id: 'a', completed_at: '2026-08-23T10:00:00.000Z' },
      { id: 'b', completed_at: null, cancelled_at: '2026-08-24T11:49:19.055Z' },
      { id: 'c', completed_at: '2026-08-22T10:00:00.000Z' },
    ];
    expect(sortTripHistoryRows(rows).map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });
});
