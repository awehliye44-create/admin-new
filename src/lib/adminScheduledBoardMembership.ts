/**
 * Admin Scheduled Rides ↔ Active Trips live-board membership SSOT.
 *
 * is_scheduled is provenance ("originally scheduled"), NOT live ownership.
 * Once activation NRO is accepted into the canonical assigned/live lifecycle,
 * the trip leaves Scheduled Rides and enters Active Trips — mutually exclusive.
 */

import {
  ACTIVE_TRIP_DB_STATUSES,
  isActiveTripDbStatus,
} from '@/lib/activeTripStatuses';
import {
  ADMIN_SEARCHING_TRIP_STATUSES,
  isAdminStaleSearchingTrip,
  type AdminTripSearchTiming,
} from '@/lib/adminActiveTripFilter';

export const ADMIN_SCHEDULED_TERMINAL_TRIP_STATUSES = [
  'completed',
  'cancelled',
  'customer_cancelled',
  'driver_cancelled',
  'expired',
  'expired_no_driver',
  'no_show',
  'declined',
] as const;

export const ADMIN_SCHEDULED_TERMINAL_SCHEDULED_STATUSES = [
  'cancelled',
  'expired',
  'no_driver_found',
] as const;

/**
 * Assigned / en-route / in-progress portion of ACTIVE_TRIP_DB_STATUSES.
 * Dispatch/search statuses stay on Scheduled while driver_id is null
 * (Finding Driver / activation NRO pending).
 */
export const ADMIN_ACTIVE_ASSIGNED_LIFECYCLE_STATUSES = ACTIVE_TRIP_DB_STATUSES.filter(
  (status) =>
    !(ADMIN_SEARCHING_TRIP_STATUSES as readonly string[]).includes(status),
) as readonly string[];

/** Statuses excluded from the live Scheduled Rides PostgREST query. */
export const ADMIN_SCHEDULED_BOARD_EXCLUDED_TRIP_STATUSES = [
  ...ADMIN_SCHEDULED_TERMINAL_TRIP_STATUSES,
  ...ADMIN_ACTIVE_ASSIGNED_LIFECYCLE_STATUSES,
] as const;

function norm(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

function nonEmptyId(value: string | null | undefined): string | null {
  const id = String(value ?? '').trim();
  return id.length > 0 ? id : null;
}

export function isAdminScheduledTerminal(input: {
  status?: string | null;
  scheduled_status?: string | null;
}): boolean {
  const status = norm(input.status);
  const scheduled = norm(input.scheduled_status);
  return (
    (ADMIN_SCHEDULED_TERMINAL_TRIP_STATUSES as readonly string[]).includes(status) ||
    (ADMIN_SCHEDULED_TERMINAL_SCHEDULED_STATUSES as readonly string[]).includes(scheduled)
  );
}

/** True when canonical status is post-accept assigned/live (never Finding Driver). */
export function isCanonicalActiveAssignedLifecycle(
  status: string | null | undefined,
): boolean {
  const s = norm(status);
  if (!s) return false;
  return (ADMIN_ACTIVE_ASSIGNED_LIFECYCLE_STATUSES as readonly string[]).includes(s);
}

export type AdminScheduledBoardTrip = {
  is_scheduled?: boolean | null;
  driver_id?: string | null;
  status?: string | null;
  scheduled_status?: string | null;
};

/**
 * Live Scheduled Rides membership.
 *
 * SCHEDULED BOARD =
 *   is_scheduled
 *   AND scheduled lifecycle still open (not terminal)
 *   AND NOT canonical active assigned lifecycle
 *   AND driver_id IS NULL (active ownership has moved to Active Trips)
 */
export function belongsOnLiveAdminScheduledBoard(
  input: AdminScheduledBoardTrip,
): boolean {
  // Explicit false → never on Scheduled. Undefined/null = scheduled-board context (tests / query rows).
  if (input.is_scheduled === false) return false;

  if (isAdminScheduledTerminal(input)) return false;
  if (nonEmptyId(input.driver_id)) return false;
  if (isCanonicalActiveAssignedLifecycle(input.status)) return false;
  return true;
}

export type AdminActiveBoardTrip = AdminScheduledBoardTrip & AdminTripSearchTiming;

/**
 * Live Active Trips membership — mutually exclusive with Scheduled Rides.
 * Uses canonical ACTIVE_TRIP_DB_STATUSES; scheduled open-lifecycle rows stay on Scheduled.
 */
export function belongsOnLiveAdminActiveBoard(
  input: AdminActiveBoardTrip,
  nowMs = Date.now(),
): boolean {
  if (!isActiveTripDbStatus(input.status)) return false;
  if (isAdminScheduledTerminal(input)) return false;
  if (isAdminStaleSearchingTrip(input, nowMs)) return false;

  // Scheduled-origin open lifecycle (Finding / Held / Pre-confirm) is owned by Scheduled board.
  if (input.is_scheduled === true && belongsOnLiveAdminScheduledBoard(input)) {
    return false;
  }
  return true;
}

/** PostgREST `.not('status', 'in', '(...)')` fragment for Scheduled board queries. */
export function adminScheduledBoardExcludedStatusInFilter(): string {
  return `(${ADMIN_SCHEDULED_BOARD_EXCLUDED_TRIP_STATUSES.join(',')})`;
}

/** PostgREST `.or(...)` keeping Active board free of scheduled open-lifecycle rows. */
export function adminActiveBoardScheduledExclusivityOrFilter(): string {
  // Instant trips OR scheduled trips that already have active driver ownership.
  return 'is_scheduled.eq.false,driver_id.not.is.null';
}
