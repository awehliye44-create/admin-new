import { supabase } from '@/integrations/supabase/client';
import { fetchPassengerDirectory, hydratePassengerIdentity } from '@/lib/tripPassengerDisplay';
import {
  ADMIN_TRIP_DATE_SORT_DEFAULT,
  TRIP_HISTORY_EVENT_AT_COLUMN,
  adminTripDateSortAscending,
  parseAdminTripDateSort,
  tripHistoryEventAt,
  type AdminTripDateSort,
} from '@/lib/adminTripListDateSort';

/** Terminal trips — aligned with Financial Reconciliation COUNTABLE_FINANCIAL_OUTCOMES. */
export const TRIP_HISTORY_FINANCIAL_OUTCOMES = [
  'COMPLETED',
  'ARRIVAL_CANCELLATION',
  'NO_SHOW',
  'LATE_PASSENGER_CANCELLATION',
] as const;

/** Chargeable terminal outcomes stay cancelled / no_show with completed_at NULL. */
export const TRIP_HISTORY_CHARGEABLE_TERMINAL_OUTCOMES = [
  'ARRIVAL_CANCELLATION',
  'NO_SHOW',
  'LATE_PASSENGER_CANCELLATION',
] as const;

export const TRIP_HISTORY_STATUSES = ['completed', 'no_show'] as const;

/** Admin table page sizes — never a hard history ceiling. */
export const TRIP_HISTORY_PAGE_SIZE_DEFAULT = 100;
export const TRIP_HISTORY_PAGE_SIZE_OPTIONS = [50, 100] as const;

/**
 * Absolute safety bound for a single request only (PostgREST / browser).
 * Full history remains in the database and is reachable via cursor pagination.
 * NEVER treat this as “only keep N trips”.
 */
export const TRIP_HISTORY_REQUEST_SAFETY_MAX = 200;

export function tripHistoryTerminalOrFilter(
  status: TripHistoryStatusFilter = 'all',
): string {
  if (status === 'completed') {
    return 'financial_outcome.eq.COMPLETED,status.eq.completed';
  }
  if (status === 'no_show') {
    return [
      'financial_outcome.eq.NO_SHOW',
      'status.eq.no_show',
      'no_show_charge_pence.gt.0',
      'cancellation_reason.eq.no_show',
    ].join(',');
  }
  if (status === 'arrival_cancellation') {
    return 'financial_outcome.eq.ARRIVAL_CANCELLATION';
  }
  if (status === 'late_cancellation') {
    return 'financial_outcome.eq.LATE_PASSENGER_CANCELLATION';
  }
  return [
    `financial_outcome.in.(${TRIP_HISTORY_FINANCIAL_OUTCOMES.join(',')})`,
    `status.in.(${TRIP_HISTORY_STATUSES.join(',')})`,
    'no_show_charge_pence.gt.0',
    'cancellation_reason.eq.no_show',
  ].join(',');
}

/**
 * Date window for Trip History.
 * Primary: completed_at in range.
 * Chargeable terminal outcomes (Arrival Cancellation / No-Show / Late Passenger
 * Cancellation) keep completed_at NULL — include via cancelled_at (then created_at).
 */
export function tripHistoryDateOrFilter(start: Date, end: Date): string {
  const s = start.toISOString();
  const e = end.toISOString();
  const terminalOutcomes = `financial_outcome.in.(${TRIP_HISTORY_CHARGEABLE_TERMINAL_OUTCOMES.join(',')})`;
  return [
    `and(completed_at.gte.${s},completed_at.lte.${e})`,
    `and(completed_at.is.null,status.eq.no_show,cancelled_at.gte.${s},cancelled_at.lte.${e})`,
    `and(completed_at.is.null,${terminalOutcomes},cancelled_at.gte.${s},cancelled_at.lte.${e})`,
    `and(completed_at.is.null,cancelled_at.is.null,status.eq.no_show,created_at.gte.${s},created_at.lte.${e})`,
    `and(completed_at.is.null,cancelled_at.is.null,${terminalOutcomes},created_at.gte.${s},created_at.lte.${e})`,
    `and(completed_at.is.null,no_show_charge_pence.gt.0,cancelled_at.gte.${s},cancelled_at.lte.${e})`,
    `and(completed_at.is.null,cancelled_at.is.null,no_show_charge_pence.gt.0,created_at.gte.${s},created_at.lte.${e})`,
    `and(completed_at.is.null,cancellation_reason.eq.no_show,cancelled_at.gte.${s},cancelled_at.lte.${e})`,
    `and(completed_at.is.null,cancelled_at.is.null,cancellation_reason.eq.no_show,created_at.gte.${s},created_at.lte.${e})`,
  ].join(',');
}

const TRIP_HISTORY_SELECT_BASE = `
  id, trip_code, trip_number, status, financial_outcome, passenger_id, passenger_name, passenger_phone,
  pickup_address, pickup_latitude, pickup_longitude, dropoff_address, dropoff_latitude, dropoff_longitude,
  estimated_fare, fare, gross_fare_pence, commission_pence, driver_net_pence, final_fare_pence,
  final_customer_fare_pence, capture_amount_pence, commissionable_fare_pence, no_show_charge_pence,
  locked_base_fare_pence, accepted_preset_offer_fare_pence, accepted_driver_offer_fare_pence,
  customer_modification_charge_pence, destination_change_adjustment_pence,
  offer_discount_pence, voucher_discount_pence, discount_pence, applied_offer_code,
  provider_fee_pence, onecab_net_pence,
  payment_status, payment_method, payment_provider, provider_order_id, provider_payment_id,
  currency_code, estimated_distance_km, estimated_duration_minutes,
  refund_amount_pence, refunded_at,
  total_stops, created_at, started_at, completed_at, cancelled_at, ${TRIP_HISTORY_EVENT_AT_COLUMN}, cancellation_reason, surge_multiplier, driver_id,
  driver_location_lat, driver_location_lng, stacked_trip_id,
  corporate_account_id, region_id, service_area_id, financial_model,
  cancellation_fee_pence,
  pricing_mode, fare_locked, vehicle_type_id, vehicle_type, fare_engine_config_id,
  waiting_charge_pence, pickup_waiting_charge_pence, stop_waiting_charge_pence, total_waiting_charge_pence, waiting_minutes, fare_breakdown,
  tip_pence, tip_amount_pence, airport_charge_pence, other_pass_through_charges_pence,
  accepted_commission_percent, driver_tier_commission_percent,
  arrival_cancellation_applied, arrival_cancellation_fee, previous_driver_id,
  driver:drivers!trips_driver_id_fkey(id, first_name, last_name, phone, driver_code, region_id),
  previous_driver:drivers!trips_previous_driver_id_fkey(id, first_name, last_name, phone, driver_code, region_id),
  service_area_join:service_areas!trips_service_area_id_fkey(region_id, region:regions(currency_code, distance_unit))
`;
const TRIP_HISTORY_SELECT_INVOICE = `
  invoice_no, invoice_pdf_url, invoice_generated_at, invoice_email_sent,
  invoice_email_sent_at, invoice_email_status, invoice_email_error,
  invoice_pdf_error, invoice_total_paid_pence, invoice_regenerated_at,
  invoice_payment_classification, invoice_paid_pence, invoice_outstanding_pence, invoice_delivery_eligible
`;

const TRIP_HISTORY_SELECT_CORPORATE = `
  corporate_account:corporate_accounts!trips_corporate_account_id_fkey(id, company_name)
`;

function isRecoverableTripHistoryQueryError(error: { message?: string; code?: string }): boolean {
  const msg = (error.message ?? '').toLowerCase();
  return (
    msg.includes('column')
    || msg.includes('does not exist')
    || msg.includes('could not find')
    || msg.includes('relationship')
    || error.code === '42703'
    || error.code === 'PGRST204'
    || error.code === 'PGRST200'
  );
}

export type TripHistoryRow = Record<string, unknown> & { id: string };

export type TripHistoryStatusFilter =
  | 'all'
  | 'completed'
  | 'no_show'
  | 'arrival_cancellation'
  | 'late_cancellation';

/** Keyset position on (trip_history_event_at, id); bound to the sort it was issued for. */
export type TripHistoryCursor = {
  eventAt: string;
  id: string;
  sort: AdminTripDateSort;
};

export type TripHistoryPage = {
  rows: TripHistoryRow[];
  nextCursor: TripHistoryCursor | null;
  hasMore: boolean;
  pageSize: number;
};

export function resolveTripHistoryPageSize(raw?: number | null): number {
  const n = Math.round(Number(raw ?? TRIP_HISTORY_PAGE_SIZE_DEFAULT));
  if (!Number.isFinite(n) || n < 1) return TRIP_HISTORY_PAGE_SIZE_DEFAULT;
  return Math.min(n, TRIP_HISTORY_REQUEST_SAFETY_MAX);
}

/**
 * Reference ordering identical to the database ORDER BY
 * (trip_history_event_at, id) — for tests and in-memory fixtures only.
 * Admin pages rely on the server order and never re-sort a fetched page.
 */
export function sortTripHistoryRows<T extends Record<string, unknown>>(
  rows: T[],
  sort: AdminTripDateSort = ADMIN_TRIP_DATE_SORT_DEFAULT,
): T[] {
  const dir = adminTripDateSortAscending(sort) ? 1 : -1;
  const at = (row: Record<string, unknown>): number => {
    const value = tripHistoryEventAt(row as Parameters<typeof tripHistoryEventAt>[0]);
    const ts = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(ts) ? ts : 0;
  };
  return [...rows].sort((a, b) => {
    const diff = at(a) - at(b);
    if (diff !== 0) return diff * dir;
    return String(a.id ?? '').localeCompare(String(b.id ?? '')) * dir;
  });
}

export function encodeTripHistoryCursor(cursor: TripHistoryCursor | null | undefined): string | null {
  if (!cursor?.id || !cursor.eventAt) return null;
  return JSON.stringify({ eventAt: cursor.eventAt, id: cursor.id, sort: cursor.sort });
}

export function decodeTripHistoryCursor(raw: string | null | undefined): TripHistoryCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { eventAt?: unknown; id?: unknown; sort?: unknown };
    if (typeof parsed.id !== 'string' || !parsed.id) return null;
    if (typeof parsed.eventAt !== 'string' || !parsed.eventAt) return null;
    return { id: parsed.id, eventAt: parsed.eventAt, sort: parseAdminTripDateSort(parsed.sort) };
  } catch {
    return null;
  }
}

async function applyTripHistoryLocationFilter(
  query: any,
  args: { regionId?: string; serviceAreaId?: string },
): Promise<any> {
  if (args.serviceAreaId && args.serviceAreaId !== 'all') {
    return query.eq('service_area_id', args.serviceAreaId);
  }
  if (args.regionId && args.regionId !== 'all') {
    const { data: areas } = await supabase
      .from('service_areas')
      .select('id')
      .eq('region_id', args.regionId)
      .is('archived_at', null);
    const areaIds = (areas ?? []).map((row: any) => row.id as string).filter(Boolean);
    if (areaIds.length > 0) {
      return query.or(`region_id.eq.${args.regionId},service_area_id.in.(${areaIds.join(',')})`);
    }
    return query.eq('region_id', args.regionId);
  }
  return query;
}

/**
 * Keyset continuation for ORDER BY trip_history_event_at, id (both DESC for
 * Newest first, both ASC for Oldest first). The event date is never NULL
 * (created_at is NOT NULL), so there is no null band to re-admit.
 */
export function tripHistoryCursorOrFilter(cursor: TripHistoryCursor): string {
  const op = adminTripDateSortAscending(cursor.sort) ? 'gt' : 'lt';
  const col = TRIP_HISTORY_EVENT_AT_COLUMN;
  return [
    `${col}.${op}.${cursor.eventAt}`,
    `and(${col}.eq.${cursor.eventAt},id.${op}.${cursor.id})`,
  ].join(',');
}

function applyTripHistoryCursorFilter(query: any, cursor: TripHistoryCursor | null | undefined): any {
  if (!cursor?.id) return query;
  return query.or(tripHistoryCursorOrFilter(cursor));
}

type TripHistoryDriverJoin = Record<string, unknown> | null | undefined;

/**
 * Terminal outcomes (no-show / chargeable cancellation) clear driver_id and keep the
 * earning driver on previous_driver_id. Attribute the row to that driver for display,
 * search and region fallback.
 */
export function attributeTripHistoryDriver<T extends Record<string, unknown>>(row: T): T {
  const current = row.driver as TripHistoryDriverJoin;
  const previous = row.previous_driver as TripHistoryDriverJoin;
  if (current || !previous) return row;
  return { ...row, driver: previous };
}

/** Server-side driver filter with the same precedence as attributeTripHistoryDriver. */
export function tripHistoryDriverOrFilter(driverId: string): string {
  return `driver_id.eq.${driverId},and(driver_id.is.null,previous_driver_id.eq.${driverId})`;
}

export type FetchTripHistoryPageArgs = {
  start: Date;
  end: Date;
  regionId?: string;
  serviceAreaId?: string;
  /** Page size — default 100. Not a history retention cap. */
  pageSize?: number;
  cursor?: TripHistoryCursor | null;
  /** Date sort — default Newest first. */
  sort?: AdminTripDateSort;
  status?: TripHistoryStatusFilter;
  driverId?: string | null;
  passengerId?: string | null;
  /** Exact or prefix trip code search (server-side; full history searchable). */
  tripCode?: string | null;
};

/**
 * One Admin Trip History page. Full trip history stays in the database forever;
 * this only pages the UI. Never deletes, archives, or hides finance rows.
 */
export async function fetchTripHistoryPage(
  args: FetchTripHistoryPageArgs,
): Promise<TripHistoryPage> {
  const pageSize = resolveTripHistoryPageSize(args.pageSize);
  const sort = parseAdminTripDateSort(args.sort);
  const ascending = adminTripDateSortAscending(sort);
  const cursor = args.cursor && args.cursor.sort === sort ? args.cursor : null;
  const selectVariants = [
    `${TRIP_HISTORY_SELECT_BASE}, ${TRIP_HISTORY_SELECT_INVOICE}, ${TRIP_HISTORY_SELECT_CORPORATE}`,
    `${TRIP_HISTORY_SELECT_BASE}, ${TRIP_HISTORY_SELECT_INVOICE}`,
    TRIP_HISTORY_SELECT_BASE,
  ];

  let lastError: { message?: string; code?: string } | null = null;

  for (const select of selectVariants) {
    let query = supabase
      .from('trips')
      .select(select)
      .or(tripHistoryTerminalOrFilter(args.status ?? 'all'))
      .or(tripHistoryDateOrFilter(args.start, args.end))
      .order(TRIP_HISTORY_EVENT_AT_COLUMN, { ascending })
      .order('id', { ascending })
      .limit(pageSize + 1);

    query = await applyTripHistoryLocationFilter(query, args);
    query = applyTripHistoryCursorFilter(query, cursor);

    if (args.driverId) query = query.or(tripHistoryDriverOrFilter(args.driverId));
    if (args.passengerId) query = query.eq('passenger_id', args.passengerId);
    if (args.tripCode && args.tripCode.trim()) {
      const code = args.tripCode.trim();
      // Prefer exact / prefix so indexes on trip_code remain useful.
      query = query.ilike('trip_code', `${code}%`);
    }

    const { data, error } = await query;
    if (!error) {
      const raw = (data ?? []) as unknown as TripHistoryRow[];
      const hasMore = raw.length > pageSize;
      const pageRows = hasMore ? raw.slice(0, pageSize) : raw;
      const directory = await fetchPassengerDirectory(
        pageRows.map((row) => (row as { passenger_id?: string | null }).passenger_id),
      );
      const rows = hydratePassengerIdentity(
        pageRows as unknown as Array<Record<string, unknown>>,
        directory,
      ).map(attributeTripHistoryDriver) as TripHistoryRow[];

      const last = rows[rows.length - 1];
      const lastEventAt = last
        ? (typeof last[TRIP_HISTORY_EVENT_AT_COLUMN] === 'string'
          ? (last[TRIP_HISTORY_EVENT_AT_COLUMN] as string)
          : tripHistoryEventAt(last as Parameters<typeof tripHistoryEventAt>[0]))
        : null;
      const nextCursor: TripHistoryCursor | null =
        hasMore && last && lastEventAt
          ? { id: last.id, eventAt: lastEventAt, sort }
          : null;

      return { rows, nextCursor, hasMore, pageSize };
    }

    lastError = error;
    if (!isRecoverableTripHistoryQueryError(error)) {
      throw error;
    }
  }

  throw lastError ?? new Error('Failed to load trip history');
}

/**
 * @deprecated Prefer fetchTripHistoryPage — kept as a thin first-page helper for callers
 * that have not yet adopted cursors. Still page-sized (default 100), never a 500/2000 hard history cap.
 */
export async function fetchTripHistoryRows(args: {
  start: Date;
  end: Date;
  regionId?: string;
  serviceAreaId?: string;
  pageSize?: number;
  sort?: AdminTripDateSort;
  status?: TripHistoryStatusFilter;
  driverId?: string | null;
  passengerId?: string | null;
  tripCode?: string | null;
}): Promise<TripHistoryRow[]> {
  const page = await fetchTripHistoryPage({ ...args, cursor: null });
  return page.rows;
}
