/**
 * Canonical event date for the Admin Trip History and Missed & Cancelled lists.
 *
 * One date positions a row, pages it and is shown on it.
 *
 * Trip History (`trip_history_event_at`):
 *   completed_at                -> COMPLETED
 *   else cancelled_at           -> ARRIVAL_CANCELLATION / NO_SHOW / LATE_PASSENGER_CANCELLATION
 *                                  (these keep completed_at NULL by design)
 *   else created_at             -> legacy terminal rows without a cancel stamp
 *
 * Missed & Cancelled (`missed_cancelled_event_at`):
 *   cancelled_at, else created_at (missed / expired bookings rarely stamp cancelled_at)
 *
 * Both are PostgREST computed columns defined in
 * supabase/migrations/20261206120000_admin_trip_list_event_date_sort.sql, so the
 * database orders by them before limit / range / keyset boundaries. The functions
 * below mirror that SQL for display and tests — never to re-sort a fetched page.
 */

export type AdminTripDateSort = 'newest' | 'oldest';

export const ADMIN_TRIP_DATE_SORT_DEFAULT: AdminTripDateSort = 'newest';

export const ADMIN_TRIP_DATE_SORT_OPTIONS: ReadonlyArray<{ value: AdminTripDateSort; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
];

export const TRIP_HISTORY_EVENT_AT_COLUMN = 'trip_history_event_at';
export const MISSED_CANCELLED_EVENT_AT_COLUMN = 'missed_cancelled_event_at';

type EventDateRow = {
  completed_at?: string | null;
  cancelled_at?: string | null;
  created_at?: string | null;
};

export function parseAdminTripDateSort(raw: unknown): AdminTripDateSort {
  return raw === 'oldest' ? 'oldest' : ADMIN_TRIP_DATE_SORT_DEFAULT;
}

export function adminTripDateSortAscending(sort: AdminTripDateSort): boolean {
  return sort === 'oldest';
}

export function tripHistoryEventAt(row: EventDateRow | null | undefined): string | null {
  if (!row) return null;
  return row.completed_at ?? row.cancelled_at ?? row.created_at ?? null;
}

export function missedCancelledEventAt(row: EventDateRow | null | undefined): string | null {
  if (!row) return null;
  return row.cancelled_at ?? row.created_at ?? null;
}
