import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tripHistoryStatusLabel } from '../../../shared/adminTripPaymentDispositionSSOT';
import { resolveTripHistoryTerminalOutcomeDisplay } from '../../../shared/tripHistoryTerminalOutcomeDisplaySSOT';
import { adminTripHistoryDisplayAt, belongsInTripHistory } from '../adminTripNoShowClassification';
import { tripHistoryOutcomeBadge } from '../tripHistoryOutcomeBadge';
import {
  attributeTripHistoryDriver,
  tripHistoryCursorOrFilter,
  tripHistoryDateOrFilter,
  tripHistoryDriverOrFilter,
  tripHistoryTerminalOrFilter,
  type TripHistoryCursor,
} from '../tripHistoryQuery';

const DRIVER_014 = {
  id: 'c40dd8a6-f422-40bc-9534-bae7be88b93e',
  first_name: 'Abdifitah',
  last_name: 'Ibrahim',
  phone: null,
  driver_code: 'MK0006',
  region_id: '7f611e59-a9e5-42c2-b65a-61376910bb5d',
};

const DRIVER_015 = {
  id: '56136f5f-1a3a-4a14-bb23-439b3951415a',
  first_name: 'Ahmed Osman',
  last_name: 'Wehliye',
  phone: null,
  driver_code: 'MK0007',
  region_id: '7f611e59-a9e5-42c2-b65a-61376910bb5d',
};

/** MK-261002-014 production row: legacy arrival_cancellation_applied=false, canonical outcome set. */
const MK_261002_014 = {
  id: '118fe5ef-4e2e-4d48-814f-31b65839225b',
  trip_code: 'MK-261002-014',
  status: 'cancelled',
  financial_outcome: 'ARRIVAL_CANCELLATION',
  financial_model: 'PLATFORM_COLLECTED',
  payment_status: 'captured',
  driver_id: null,
  previous_driver_id: DRIVER_014.id,
  driver: null,
  previous_driver: DRIVER_014,
  cancellation_reason: 'booked-by-mistake',
  cancelled_at: '2026-10-02T12:29:40.350Z',
  completed_at: null,
  created_at: '2026-10-02T12:26:09.979Z',
  arrival_cancellation_applied: false,
  arrival_cancellation_fee: null,
  arrival_cancellation_reason: null,
  no_show_charge_pence: null,
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
    payment_session_id: 'ade38aee-5b2e-437b-81dd-c87b523172e6',
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
    terminal_disposition_reason: 'ARRIVAL_CANCELLATION_FEE',
    is_no_show_outcome: false,
  },
};

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
  no_show_charge_pence: 450,
  capture_amount_pence: 450,
  provider_fee_pence: 24,
  commission_pence: 75,
  driver_net_pence: 425,
  gross_fare_pence: 500,
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

type Row = Record<string, unknown> & { id: string; completed_at: string | null };

function splitTopLevel(filter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of filter) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

/** Minimal PostgREST logic-tree evaluator for the operators Trip History emits. */
function evalTerm(row: Row, term: string): boolean {
  if (term.startsWith('and(') && term.endsWith(')')) {
    return splitTopLevel(term.slice(4, -1)).every((t) => evalTerm(row, t));
  }
  const firstDot = term.indexOf('.');
  const secondDot = term.indexOf('.', firstDot + 1);
  const col = term.slice(0, firstDot);
  const op = term.slice(firstDot + 1, secondDot);
  const value = term.slice(secondDot + 1);
  const cell = row[col] as string | number | null | undefined;
  if (op === 'is' && value === 'null') return cell === null || cell === undefined;
  if (cell === null || cell === undefined) return false;
  if (op === 'eq') return String(cell) === value;
  if (op === 'in') return value.slice(1, -1).split(',').includes(String(cell));
  if (op === 'gt') return Number(cell) > Number(value);
  if (op === 'lt') return String(cell) < value;
  if (op === 'gte') return String(cell) >= value;
  if (op === 'lte') return String(cell) <= value;
  throw new Error(`unsupported term ${term}`);
}

const matchesOr = (row: Row, filter: string) => splitTopLevel(filter).some((t) => evalTerm(row, t));

function orderDesc(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    if (a.completed_at === null && b.completed_at !== null) return 1;
    if (a.completed_at !== null && b.completed_at === null) return -1;
    if (a.completed_at !== b.completed_at) return String(b.completed_at) < String(a.completed_at) ? -1 : 1;
    return b.id < a.id ? -1 : 1;
  });
}

function paginate(rows: Row[], pageSize: number): string[] {
  const seen: string[] = [];
  let cursor: TripHistoryCursor | null = null;
  for (let guard = 0; guard < 100; guard += 1) {
    const filtered = cursor ? rows.filter((row) => matchesOr(row, tripHistoryCursorOrFilter(cursor!))) : rows;
    const page = orderDesc(filtered).slice(0, pageSize + 1);
    const pageRows = page.slice(0, pageSize);
    seen.push(...pageRows.map((r) => r.id));
    if (page.length <= pageSize) break;
    const last = pageRows[pageRows.length - 1];
    cursor = { id: last.id, completedAt: last.completed_at };
  }
  return seen;
}

const WINDOW_START = new Date('2026-09-25T00:00:00.000Z');
const WINDOW_END = new Date('2026-10-02T23:59:59.999Z');

const PLAIN_CANCELLED: Row = {
  id: 'plain-cancel',
  status: 'cancelled',
  financial_outcome: 'CANCELLED_NO_FEE',
  completed_at: null,
  cancelled_at: '2026-10-02T10:12:16.000Z',
  created_at: '2026-10-02T10:00:00.000Z',
};
const LEGACY_WITH_FEE: Row = {
  id: 'legacy-with-fee',
  status: 'cancelled',
  financial_outcome: 'CANCELLED_WITH_FEE',
  completed_at: null,
  cancelled_at: '2026-09-27T07:02:56.077Z',
  created_at: '2026-09-27T06:59:09.000Z',
};
const LATE: Row = {
  id: 'late-cancel',
  status: 'cancelled',
  financial_outcome: 'LATE_PASSENGER_CANCELLATION',
  completed_at: null,
  cancelled_at: '2026-09-30T09:00:00.000Z',
  created_at: '2026-09-30T08:50:00.000Z',
};

describe('MK-261002-014 is returned by Admin Trip History', () => {
  const r014 = MK_261002_014 as unknown as Row;
  const r015 = MK_261002_015 as unknown as Row;

  it('passes the default (all) terminal filter on financial_outcome alone', () => {
    expect(matchesOr(r014, tripHistoryTerminalOrFilter('all'))).toBe(true);
    expect(matchesOr(r015, tripHistoryTerminalOrFilter('all'))).toBe(true);
  });

  it('passes the date window with completed_at NULL via cancelled_at', () => {
    const dates = tripHistoryDateOrFilter(WINDOW_START, WINDOW_END);
    expect(matchesOr(r014, dates)).toBe(true);
    expect(matchesOr(r015, dates)).toBe(true);
    expect(matchesOr(LATE, dates)).toBe(true);
  });

  it('does not depend on arrival_cancellation_applied', () => {
    expect(MK_261002_014.arrival_cancellation_applied).toBe(false);
    expect(matchesOr(r014, tripHistoryTerminalOrFilter('arrival_cancellation'))).toBe(true);
    expect(matchesOr(r015, tripHistoryTerminalOrFilter('arrival_cancellation'))).toBe(false);
  });

  it('keeps free and legacy fee cancellations out of Trip History', () => {
    for (const row of [PLAIN_CANCELLED, LEGACY_WITH_FEE]) {
      expect(matchesOr(row, tripHistoryTerminalOrFilter('all'))).toBe(false);
    }
  });

  it('every terminal row stays reachable across pages of 50 and 100 with no duplicates', () => {
    const completed: Row[] = Array.from({ length: 137 }, (_, i) => ({
      id: `c-${String(i).padStart(3, '0')}`,
      status: 'completed',
      financial_outcome: null,
      completed_at: new Date(Date.UTC(2026, 8, 26, 0, i)).toISOString(),
    }));
    const all = [...completed, r014, r015, LATE, PLAIN_CANCELLED, LEGACY_WITH_FEE];
    const terminal = tripHistoryTerminalOrFilter('all');
    const dates = tripHistoryDateOrFilter(WINDOW_START, WINDOW_END);
    const base = all.filter((row) => matchesOr(row, terminal) && matchesOr(row, dates));
    expect(base.map((r) => r.id)).toEqual(expect.arrayContaining([r014.id, r015.id, LATE.id]));
    for (const size of [50, 100]) {
      const seen = paginate(base, size);
      expect(seen.length).toBe(base.length);
      expect(new Set(seen).size).toBe(base.length);
      expect(seen).toContain(r014.id);
      expect(seen).toContain(r015.id);
    }
  });

  it('driver filter resolves the preserved terminal driver only when driver_id is cleared', () => {
    expect(matchesOr(r014, tripHistoryDriverOrFilter(DRIVER_014.id))).toBe(true);
    expect(matchesOr(r015, tripHistoryDriverOrFilter(DRIVER_015.id))).toBe(true);
    expect(matchesOr(r014, tripHistoryDriverOrFilter(DRIVER_015.id))).toBe(false);
    const reassigned = { ...r014, driver_id: 'someone-else' } as Row;
    expect(matchesOr(reassigned, tripHistoryDriverOrFilter(DRIVER_014.id))).toBe(false);
  });
});

describe('MK-261002-014 Admin presentation', () => {
  it('is labelled Arrival Cancellation and attributed to MK0006', () => {
    expect(tripHistoryStatusLabel(MK_261002_014)).toBe('Arrival Cancellation');
    expect(tripHistoryOutcomeBadge(MK_261002_014)?.label).toBe('Arrival Cancellation');
    expect(attributeTripHistoryDriver(MK_261002_014).driver).toEqual(DRIVER_014);
    expect(belongsInTripHistory(MK_261002_014)).toBe(true);
  });

  it('shows the cancellation time, not N/A', () => {
    expect(adminTripHistoryDisplayAt(MK_261002_014)).toBe('2026-10-02T12:29:40.350Z');
  });

  it('presents 450 charged / 24 fee / 426 entitlement / 0 commission', () => {
    const display = resolveTripHistoryTerminalOutcomeDisplay(MK_261002_014);
    expect(display?.outcome_kind).toBe('ARRIVAL_CANCELLATION');
    expect(display?.customer_charge_pence).toBe(450);
    expect(display?.provider_fee_pence).toBe(24);
    expect(display?.driver_entitlement_pence).toBe(426);
    expect(display?.onecab_commission_pence).toBe(0);
    expect(display?.entitlement_pending).toBe(false);
    expect(display?.original_quote_pence).toBe(500);
  });
});

describe('Trip History outcome set is never flattened into Cancelled', () => {
  it('distinguishes all five outcomes', () => {
    expect(tripHistoryStatusLabel({ status: 'completed', financial_outcome: null })).toBe('Completed');
    expect(tripHistoryStatusLabel(MK_261002_014)).toBe('Arrival Cancellation');
    expect(tripHistoryStatusLabel(MK_261002_015)).toBe('No-Show');
    expect(tripHistoryStatusLabel({ status: 'cancelled', financial_outcome: 'LATE_PASSENGER_CANCELLATION' }))
      .toBe('Late Passenger Cancellation');
    expect(tripHistoryStatusLabel({ status: 'cancelled', financial_outcome: 'CANCELLED_NO_FEE' })).toBe('Cancelled');
  });

  it('badges only chargeable terminal outcomes', () => {
    expect(tripHistoryOutcomeBadge(MK_261002_015)?.label).toBe('No-Show');
    expect(tripHistoryOutcomeBadge({ status: 'cancelled', financial_outcome: 'LATE_PASSENGER_CANCELLATION' })?.label)
      .toBe('Late Passenger Cancellation');
    expect(tripHistoryOutcomeBadge({ status: 'completed', financial_outcome: null })).toBeNull();
    expect(tripHistoryOutcomeBadge({ status: 'cancelled', financial_outcome: 'CANCELLED_NO_FEE' })).toBeNull();
  });
});

describe('Trip History terminal outcome wiring lock', () => {
  const query = readFileSync(resolve(__dirname, '../tripHistoryQuery.ts'), 'utf8');
  const page = readFileSync(resolve(__dirname, '../../pages/TripHistory.tsx'), 'utf8');
  it('admits ARRIVAL_CANCELLATION and filters drivers through previous_driver_id', () => {
    expect(query).toContain("'ARRIVAL_CANCELLATION'");
    expect(query).toContain('query.or(tripHistoryDriverOrFilter(args.driverId))');
  });
  it('renders the outcome badge and offers an Arrival Cancellation filter', () => {
    expect(page).toContain('tripHistoryOutcomeBadge(trip)');
    expect(page).toContain('<SelectItem value="arrival_cancellation">Arrival Cancellation</SelectItem>');
  });
});
