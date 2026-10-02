import { MISSED_CANCELLED_STATUSES } from '@/lib/adminTripNoShowClassification';
import { TRIP_HISTORY_FINANCIAL_OUTCOMES } from '@/lib/tripHistoryQuery';
import type { AdminEventBand } from '@/lib/adminEventOrder';

/**
 * Admin page ownership for terminal outcomes. Trip History owns
 * `tripHistoryTerminalOrFilter('all')`; Missed & Cancelled owns its exact complement
 * within cancelled / missed / expired statuses. Canonical authority is
 * financial_outcome — never operational status and never arrival_cancellation_applied.
 *
 * Each entry is one PostgREST `or` group; groups AND together. `not.in` / `neq` alone
 * evaluate NULL to unknown and would drop ordinary cancellations, hence the `is.null` arms.
 */
export const MISSED_CANCELLED_OWNERSHIP_OR_FILTERS = [
  `financial_outcome.is.null,financial_outcome.not.in.(${TRIP_HISTORY_FINANCIAL_OUTCOMES.join(',')})`,
  'no_show_charge_pence.is.null,no_show_charge_pence.lte.0',
  'cancellation_reason.is.null,cancellation_reason.neq.no_show',
] as const;

export function applyMissedCancelledOwnership<Q extends { or: (filter: string) => Q }>(query: Q): Q {
  let q = query;
  for (const filter of MISSED_CANCELLED_OWNERSHIP_OR_FILTERS) q = q.or(filter);
  return q;
}

export type MissedCancelledStatusFilter =
  | 'all'
  | 'cancelled'
  | 'customer_cancelled'
  | 'missed'
  | 'expired';

export function missedCancelledStatusList(filter: string): string[] {
  if (filter === 'expired') return ['expired', 'expired_no_driver'];
  if ((MISSED_CANCELLED_STATUSES as readonly string[]).includes(filter)) return [filter];
  return [...MISSED_CANCELLED_STATUSES];
}

export const MISSED_CANCELLED_CANCELLED_STATUSES = ['cancelled', 'customer_cancelled'] as const;
export const MISSED_CANCELLED_MISSED_STATUSES = ['missed', 'expired', 'expired_no_driver'] as const;

/** Missed & Cancelled event date: cancelled_at (cancel / miss / expiry), else created_at. */
export const MISSED_CANCELLED_EVENT_BANDS: readonly AdminEventBand[] = [
  { column: 'cancelled_at', nullColumns: [] },
  { column: 'created_at', nullColumns: ['cancelled_at'] },
];

export function missedCancelledEventAt(row: {
  cancelled_at?: string | null;
  created_at?: string | null;
}): string | null {
  return row.cancelled_at ?? row.created_at ?? null;
}

/** Date window on the event date — the same basis the list sorts by. */
export function missedCancelledEventWindowOrFilter(start: Date, end: Date): string {
  const s = start.toISOString();
  const e = end.toISOString();
  return [
    `and(cancelled_at.gte.${s},cancelled_at.lte.${e})`,
    `and(cancelled_at.is.null,created_at.gte.${s},created_at.lte.${e})`,
  ].join(',');
}
