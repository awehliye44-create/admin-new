import type { AdminPageFilter } from '@/lib/adminPageGatedData';
import { MISSED_CANCELLED_STATUSES } from '@/lib/adminTripNoShowClassification';
import { TRIP_HISTORY_FINANCIAL_OUTCOMES } from '@/lib/tripHistoryQuery';

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

/** Same ownership as applyMissedCancelledOwnership, for admin_page_select and_or_groups. */
export function missedCancelledOwnershipAndOrGroups(): AdminPageFilter[][][] {
  return [
    [
      [{ op: 'is_null', col: 'financial_outcome' }],
      [{ op: 'not_in', col: 'financial_outcome', val: [...TRIP_HISTORY_FINANCIAL_OUTCOMES] }],
    ],
    [
      [{ op: 'is_null', col: 'no_show_charge_pence' }],
      [{ op: 'lte', col: 'no_show_charge_pence', val: 0 }],
    ],
    [
      [{ op: 'is_null', col: 'cancellation_reason' }],
      [{ op: 'neq', col: 'cancellation_reason', val: 'no_show' }],
    ],
  ];
}

export const MISSED_CANCELLED_CANCELLED_STATUSES = ['cancelled', 'customer_cancelled'] as const;
export const MISSED_CANCELLED_MISSED_STATUSES = ['missed', 'expired', 'expired_no_driver'] as const;

/** Status filter → statuses, always inside MISSED_CANCELLED_STATUSES. */
export function missedCancelledStatusList(filter: string): string[] {
  if (filter === 'expired') return ['expired', 'expired_no_driver'];
  if ((MISSED_CANCELLED_STATUSES as readonly string[]).includes(filter)) return [filter];
  return [...MISSED_CANCELLED_STATUSES];
}
