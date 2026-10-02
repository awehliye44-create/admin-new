/**
 * Missed & Cancelled — canonical bucket per trip for stats, quoted-fare totals and the
 * Arrival Cancellation fee block. Display only; no Payment Sessions / wallet writes.
 *
 * Chargeable terminal kind comes from resolveTripHistoryTerminalOutcomeKind (the same
 * SSOT as the badge). Each trip lands in exactly one bucket.
 */

import {
  resolveTripHistoryTerminalOutcomeDisplay,
  resolveTripHistoryTerminalOutcomeKind,
  type TripHistoryTerminalOutcomeTrip,
} from '../../shared/tripHistoryTerminalOutcomeDisplaySSOT';
import {
  resolveAdminCommittedCustomerFarePence,
  type AdminCommittedFareTripRow,
} from './adminTripCommittedFareDisplay';

export type MissedCancelledBucket =
  | 'ARRIVAL_CANCELLATION'
  | 'NO_SHOW'
  | 'LATE_PASSENGER_CANCELLATION'
  | 'CANCELLED_NO_FEE'
  | 'MISSED_EXPIRED';

export type MissedCancelledStatsRow = TripHistoryTerminalOutcomeTrip &
  AdminCommittedFareTripRow & {
    arrival_cancellation_fee?: number | null;
  };

export type MissedCancelledStats = {
  arrival_cancellation: number;
  no_show: number;
  late_passenger_cancellation: number;
  chargeable_total: number;
  cancelled_no_fee: number;
  cancelled_legacy_fee_evidence: number;
  missed_expired: number;
  total: number;
};

const MISSED_EXPIRED_STATUSES = new Set(['missed', 'expired', 'expired_no_driver']);

/**
 * Range stats cover the Missed & Cancelled statuses plus status `no_show`. No-show rows
 * are listed in Trip History, never in this list, but the No-Show counter must include
 * every no-show in range — including ones stamped `no_show` rather than `cancelled`.
 * Each trip is still counted once, in one bucket.
 */
export const MISSED_CANCELLED_STATS_EXTRA_STATUSES = ['no_show'] as const;

function positivePence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

export function classifyMissedCancelledBucket(
  trip: MissedCancelledStatsRow | null | undefined,
): MissedCancelledBucket {
  const kind = resolveTripHistoryTerminalOutcomeKind(trip);
  if (kind) return kind;
  const status = String(trip?.status ?? '').trim().toLowerCase();
  if (MISSED_EXPIRED_STATUSES.has(status)) return 'MISSED_EXPIRED';
  return 'CANCELLED_NO_FEE';
}

export function isChargeableTerminalBucket(bucket: MissedCancelledBucket): boolean {
  return bucket === 'ARRIVAL_CANCELLATION'
    || bucket === 'NO_SHOW'
    || bucket === 'LATE_PASSENGER_CANCELLATION';
}

function hasLegacyFeeEvidence(trip: MissedCancelledStatsRow): boolean {
  return positivePence(trip.capture_amount_pence) > 0
    || positivePence(trip.cancellation_fee_pence) > 0
    || String(trip.financial_outcome ?? '').trim().toUpperCase() === 'CANCELLED_WITH_FEE';
}

export function summarizeMissedCancelledStats(
  rows: readonly MissedCancelledStatsRow[],
): MissedCancelledStats {
  const stats: MissedCancelledStats = {
    arrival_cancellation: 0,
    no_show: 0,
    late_passenger_cancellation: 0,
    chargeable_total: 0,
    cancelled_no_fee: 0,
    cancelled_legacy_fee_evidence: 0,
    missed_expired: 0,
    total: 0,
  };
  for (const row of rows) {
    const bucket = classifyMissedCancelledBucket(row);
    stats.total += 1;
    switch (bucket) {
      case 'ARRIVAL_CANCELLATION':
        stats.arrival_cancellation += 1;
        stats.chargeable_total += 1;
        break;
      case 'NO_SHOW':
        stats.no_show += 1;
        stats.chargeable_total += 1;
        break;
      case 'LATE_PASSENGER_CANCELLATION':
        stats.late_passenger_cancellation += 1;
        stats.chargeable_total += 1;
        break;
      case 'MISSED_EXPIRED':
        stats.missed_expired += 1;
        break;
      default:
        stats.cancelled_no_fee += 1;
        if (hasLegacyFeeEvidence(row)) stats.cancelled_legacy_fee_evidence += 1;
    }
  }
  return stats;
}

/**
 * Chargeable terminal outcomes never contribute to "Quoted fare impact": the customer
 * paid a terminal fee, and the original quote is context only, never a total.
 */
export function excludesQuotedFareImpact(
  trip: MissedCancelledStatsRow | null | undefined,
): boolean {
  return isChargeableTerminalBucket(classifyMissedCancelledBucket(trip));
}

export function missedCancelledQuotedFareImpactPence(
  trip: MissedCancelledStatsRow | null | undefined,
  resolveCommittedFarePence: (row: AdminCommittedFareTripRow) => number = resolveAdminCommittedCustomerFarePence,
): number {
  if (!trip || excludesQuotedFareImpact(trip)) return 0;
  return resolveCommittedFarePence(trip);
}

/**
 * Arrival Cancellation fee for the detail block, in pence. Financial evidence first
 * (Payment Sessions capture / capture_amount_pence / cancellation_fee_pence); the legacy
 * integer-pence arrival_cancellation_fee only supplements when no capture evidence exists.
 * Returns null when the trip is not an Arrival Cancellation.
 */
export function resolveAdminArrivalCancellationFeePence(
  trip: MissedCancelledStatsRow | null | undefined,
): number | null {
  if (!trip || resolveTripHistoryTerminalOutcomeKind(trip) !== 'ARRIVAL_CANCELLATION') return null;
  const display = resolveTripHistoryTerminalOutcomeDisplay(trip);
  const charged = positivePence(display?.customer_charge_pence);
  if (charged > 0) return charged;
  return positivePence(trip.arrival_cancellation_fee);
}
