import {
  resolveTripHistoryTerminalOutcomeKind,
  type TripHistoryTerminalOutcomeTrip,
} from '../../shared/tripHistoryTerminalOutcomeDisplaySSOT';
import {
  tripHistoryStatusLabel,
  type AdminTripPaymentDispositionTrip,
} from '../../shared/adminTripPaymentDispositionSSOT';
import { tripHistoryNoShowDisplayLabel } from '@/lib/adminTripNoShowClassification';

type TripHistoryOutcomeBadgeTrip = TripHistoryTerminalOutcomeTrip & AdminTripPaymentDispositionTrip;

export type TripHistoryOutcomeBadge = {
  label: string;
  className: string;
};

const OUTCOME_BADGE_CLASS = {
  ARRIVAL_CANCELLATION: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
  NO_SHOW: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  LATE_PASSENGER_CANCELLATION: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400',
} as const;

/**
 * Trip History outcome badge for chargeable terminal outcomes. Canonical
 * financial_outcome wins; legacy no-show evidence still badges as No-Show.
 * Completed and plain cancelled rows return null.
 */
export function tripHistoryOutcomeBadge(
  trip: TripHistoryOutcomeBadgeTrip | null | undefined,
): TripHistoryOutcomeBadge | null {
  if (!trip) return null;
  const kind = resolveTripHistoryTerminalOutcomeKind(trip);
  if (kind) {
    return { label: tripHistoryStatusLabel(trip), className: OUTCOME_BADGE_CLASS[kind] };
  }
  const legacyNoShow = tripHistoryNoShowDisplayLabel(trip);
  return legacyNoShow ? { label: legacyNoShow, className: OUTCOME_BADGE_CLASS.NO_SHOW } : null;
}
