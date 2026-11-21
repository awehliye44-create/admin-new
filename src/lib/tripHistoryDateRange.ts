import { endOfDay, parseISO, startOfDay, subDays } from 'date-fns';
import type { AdminTripDateSort } from '@/lib/adminTripListDateSort';

/** Trip History date-range options. `all` has no lower bound, so Oldest first reaches the first trip ever. */
export type TripHistoryDateFilter = 'today' | '7days' | '30days' | '90days' | 'all' | 'custom';

export const TRIP_HISTORY_DATE_FILTER_DEFAULT: TripHistoryDateFilter = '7days';

export const TRIP_HISTORY_DATE_FILTER_OPTIONS: ReadonlyArray<{ value: TripHistoryDateFilter; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7days', label: 'Last 7 Days' },
  { value: '30days', label: 'Last 30 Days' },
  { value: '90days', label: 'Last 90 Days' },
  { value: 'all', label: 'All Time' },
  { value: 'custom', label: 'Custom Range' },
];

/** Lower bound for "no lower bound" — earlier than any trip the platform can hold. */
export const TRIP_HISTORY_ALL_TIME_START = new Date('2000-01-01T00:00:00.000Z');

export function parseTripHistoryDateFilter(raw: unknown): TripHistoryDateFilter {
  return TRIP_HISTORY_DATE_FILTER_OPTIONS.some((o) => o.value === raw)
    ? (raw as TripHistoryDateFilter)
    : TRIP_HISTORY_DATE_FILTER_DEFAULT;
}

export function resolveTripHistoryDateRange(
  filter: TripHistoryDateFilter,
  customStartDate: string,
  customEndDate: string,
  now: Date = new Date(),
): { start: Date; end: Date } {
  switch (filter) {
    case 'today':
      return { start: startOfDay(now), end: endOfDay(now) };
    case '7days':
      return { start: startOfDay(subDays(now, 7)), end: endOfDay(now) };
    case '30days':
      return { start: startOfDay(subDays(now, 30)), end: endOfDay(now) };
    case '90days':
      return { start: startOfDay(subDays(now, 90)), end: endOfDay(now) };
    case 'all':
      return { start: TRIP_HISTORY_ALL_TIME_START, end: endOfDay(now) };
    case 'custom': {
      let start = customStartDate ? startOfDay(parseISO(customStartDate)) : TRIP_HISTORY_ALL_TIME_START;
      let end = customEndDate ? endOfDay(parseISO(customEndDate)) : endOfDay(now);
      if (start > end) {
        const swap = start;
        start = startOfDay(end);
        end = endOfDay(swap);
      }
      return { start, end };
    }
  }
}

/**
 * Picking Oldest first on a rolling window (Today / Last N days) would only show the
 * oldest trips inside that window, so it widens the range to All Time. A custom range
 * is the admin's explicit choice and is kept.
 */
export function tripHistoryDateFilterForSort(
  sort: AdminTripDateSort,
  current: TripHistoryDateFilter,
): TripHistoryDateFilter {
  if (sort === 'oldest' && current !== 'custom') return 'all';
  return current;
}
