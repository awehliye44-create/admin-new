import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tripHistoryStatusLabel } from '../../../shared/adminTripPaymentDispositionSSOT';
import { resolveTripHistoryTerminalOutcomeDisplay } from '../../../shared/tripHistoryTerminalOutcomeDisplaySSOT';
import { belongsInMissedCancelled, belongsInTripHistory } from '../adminTripNoShowClassification';
import {
  classifyMissedCancelledBucket,
  excludesQuotedFareImpact,
  missedCancelledQuotedFareImpactPence,
  resolveAdminArrivalCancellationFeePence,
  summarizeMissedCancelledStats,
} from '../missedCancelledTerminalStats';
import {
  attributeTripHistoryDriver,
  TRIP_HISTORY_EVENT_BANDS,
  tripHistoryDateOrFilter,
  tripHistoryTerminalOrFilter,
} from '../tripHistoryQuery';
import { eventCursorOrFilter } from '../adminEventOrder';
import { simulateAllPages, type SimRow } from './helpers/postgrestSim';

const DRIVER_015 = {
  id: '56136f5f-1a3a-4a14-bb23-439b3951415a',
  first_name: 'Driver',
  last_name: 'Fifteen',
  phone: null,
  driver_code: 'D015',
  region_id: 'region-mk',
};

/** MK-261002-015 production values: cancel-trip No-Show path, stale normal-ride stamp 500/75/425. */
const MK_261002_015 = {
  id: '98cab445-aa22-401a-8aac-e53210990273',
  trip_code: 'MK-261002-015',
  status: 'no_show',
  financial_outcome: 'NO_SHOW',
  financial_model: 'PLATFORM_COLLECTED',
  payment_status: 'captured',
  driver_id: null,
  previous_driver_id: DRIVER_015.id,
  driver: null,
  previous_driver: DRIVER_015,
  cancellation_reason: 'no_show',
  cancelled_at: '2026-10-02T12:43:36.989Z',
  completed_at: null,
  created_at: '2026-10-02T12:37:23.279Z',
  arrival_cancellation_applied: false,
  arrival_cancellation_fee: null,
  arrival_cancellation_reason: null,
  no_show_charge_pence: 450,
  capture_amount_pence: 450,
  cancellation_fee_pence: 450,
  provider_fee_pence: 24,
  commission_pence: 75,
  driver_net_pence: 425,
  gross_fare_pence: 500,
  final_fare_pence: 500,
  estimated_fare: 5,
  currency_code: 'GBP',
  payment_disposition: {
    payment_session_id: 'f96d1b91-6a83-4f2f-9611-0a9b29a6cc48',
    captured_amount_pence: 450,
    released_amount_pence: 300,
    refunded_amount_pence: 0,
    provider_processing_fee_pence: 24,
    fee_status: 'ACTUAL',
    provider_state: 'COMPLETED',
    payment_status: 'captured',
    payment_label: 'Captured',
    amount_label: null,
    amount_pence: 450,
    financial_model: 'PLATFORM_COLLECTED',
    terminal_disposition_reason: 'CUSTOMER_NO_SHOW',
    is_no_show_outcome: true,
  },
};

describe('MK-261002-015 Admin routing', () => {
  it('badge is No-Show', () => {
    expect(tripHistoryStatusLabel(MK_261002_015)).toBe('No-Show');
  });

  it('is owned by Trip History, never the Missed & Cancelled list', () => {
    expect(belongsInTripHistory(MK_261002_015)).toBe(true);
    expect(belongsInMissedCancelled(MK_261002_015)).toBe(false);
  });

  it('matches the Trip History terminal and date filters (completed_at NULL, cancelled_at in range)', () => {
    expect(tripHistoryTerminalOrFilter('all')).toContain('status.in.(completed,no_show)');
    expect(tripHistoryTerminalOrFilter('no_show')).toContain('financial_outcome.eq.NO_SHOW');
    const filter = tripHistoryDateOrFilter(
      new Date('2026-09-25T00:00:00.000Z'),
      new Date('2026-10-02T23:59:59.999Z'),
    );
    expect(filter).toContain(
      'and(completed_at.is.null,status.eq.no_show,cancelled_at.gte.2026-09-25T00:00:00.000Z,cancelled_at.lte.2026-10-02T23:59:59.999Z)',
    );
  });

  it('is attributed to previous_driver_id for display and search', () => {
    const row = attributeTripHistoryDriver(MK_261002_015);
    expect(row.driver).toEqual(DRIVER_015);
    const assigned = { ...MK_261002_015, driver: { ...DRIVER_015, id: 'current' } };
    expect(attributeTripHistoryDriver(assigned).driver).toEqual({ ...DRIVER_015, id: 'current' });
  });
});

describe('MK-261002-015 Admin financial display', () => {
  it('payment outcome is 450 charged / 24 fee / 426 entitlement / 0 commission', () => {
    const display = resolveTripHistoryTerminalOutcomeDisplay(MK_261002_015);
    expect(display?.outcome_kind).toBe('NO_SHOW');
    expect(display?.customer_charge_pence).toBe(450);
    expect(display?.provider_fee_pence).toBe(24);
    expect(display?.driver_entitlement_pence).toBe(426);
    expect(display?.onecab_commission_pence).toBe(0);
    expect(display?.entitlement_pending).toBe(false);
    expect(display?.original_quote_pence).toBe(500);
  });

  it('never renders an Arrival Cancellation fee block', () => {
    expect(resolveAdminArrivalCancellationFeePence(MK_261002_015)).toBeNull();
  });

  it('counts once as No-Show and excludes the £5.00 quote from totals', () => {
    expect(classifyMissedCancelledBucket(MK_261002_015)).toBe('NO_SHOW');
    expect(excludesQuotedFareImpact(MK_261002_015)).toBe(true);
    expect(missedCancelledQuotedFareImpactPence(MK_261002_015)).toBe(0);
    const stats = summarizeMissedCancelledStats([MK_261002_015]);
    expect(stats.no_show).toBe(1);
    expect(stats.chargeable_total).toBe(1);
    expect(stats.total).toBe(1);
  });
});

describe('Trip History keyset pagination reaches every event band', () => {
  const completed: SimRow[] = Array.from({ length: 130 }, (_, i) => ({
    id: `c-${String(i).padStart(3, '0')}`,
    completed_at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
    cancelled_at: null,
    created_at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
  }));
  const noShows: SimRow[] = [
    { id: MK_261002_015.id, completed_at: null, cancelled_at: MK_261002_015.cancelled_at, created_at: MK_261002_015.created_at },
    { id: '00000000-0000-0000-0000-000000000001', completed_at: null, cancelled_at: null, created_at: '2026-08-31T23:00:00.000Z' },
  ];
  const rows = [...completed, ...noShows];
  const all = () => true;

  it('every row (including MK-261002-015) is reachable across pages of 50 and 100, both orders', () => {
    for (const order of ['newest', 'oldest'] as const) {
      for (const size of [50, 100]) {
        const seen = simulateAllPages(rows, TRIP_HISTORY_EVENT_BANDS, all, order, size);
        expect(seen.length).toBe(rows.length);
        expect(new Set(seen).size).toBe(rows.length);
        expect(seen).toContain(MK_261002_015.id);
      }
    }
  });

  it('MK-261002-015 sorts by its cancellation time instead of trailing every completed trip', () => {
    const newest = simulateAllPages(rows, TRIP_HISTORY_EVENT_BANDS, all, 'newest', 50);
    expect(newest[0]).toBe(MK_261002_015.id);
    expect(newest[newest.length - 1]).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('band continuation stays inside its own column', () => {
    const cursor = { eventAt: '2026-10-02T12:43:36.989+00:00', id: 'x' };
    expect(eventCursorOrFilter('cancelled_at', cursor, 'newest'))
      .toBe('cancelled_at.lt.2026-10-02T12:43:36.989+00:00,and(cancelled_at.eq.2026-10-02T12:43:36.989+00:00,id.lt.x)');
    expect(eventCursorOrFilter('completed_at', cursor, 'oldest'))
      .toBe('completed_at.gt.2026-10-02T12:43:36.989+00:00,and(completed_at.eq.2026-10-02T12:43:36.989+00:00,id.gt.x)');
  });
});

describe('Trip History wiring lock', () => {
  const src = readFileSync(resolve(__dirname, '../tripHistoryQuery.ts'), 'utf8');
  it('selects previous_driver and attributes rows', () => {
    expect(src).toContain('previous_driver:drivers!trips_previous_driver_id_fkey(');
    expect(src).toContain('.map(attributeTripHistoryDriver)');
  });
  it('pages each event band with its own keyset before merging', () => {
    expect(src).toContain('TRIP_HISTORY_EVENT_BANDS.map((band)');
    expect(src).toContain('query = applyEventBand(query, band)');
    expect(src).toContain('query.or(eventCursorOrFilter(band.column, args.cursor, order))');
    expect(src).toContain(".order(band.column, { ascending })");
    expect(src).toContain('mergeEventBandPages(');
    expect(src).not.toContain("order('completed_at', { ascending: false, nullsFirst: false })");
  });
});
