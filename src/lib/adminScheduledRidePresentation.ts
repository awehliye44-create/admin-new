/**
 * Canonical Admin Scheduled Rides presentation SSOT.
 * Status + Driver are derived together from ownership fields — never independently.
 *
 * Ownership authority:
 * - driver_id → active assigned driver
 * - confirmed_driver_id + driver_id null → PRE-CONFIRMED
 * - neither → Unassigned
 *
 * Never derive Driver from offer history, pending_release_driver_id, or stale waves.
 */

export type AdminScheduledDriverKind = 'unassigned' | 'pre_confirmed' | 'assigned';

export type AdminScheduledStatusKey =
  | 'held'
  | 'available'
  | 'pre_confirmed'
  | 'finding_driver'
  | 'driver_assigned'
  | 'expired'
  | 'cancelled'
  | 'awaiting_accept';

export type AdminScheduledDriverRef = {
  id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
} | null | undefined;

export type AdminScheduledRidePresentationInput = {
  id?: string | null;
  driver_id?: string | null;
  confirmed_driver_id?: string | null;
  scheduled_status?: string | null;
  status?: string | null;
  scheduled_broadcast_at?: string | null;
  scheduled_at?: string | null;
  driver?: AdminScheduledDriverRef;
  confirmed_driver?: AdminScheduledDriverRef;
};

export type AdminScheduledRidePresentation = {
  statusKey: AdminScheduledStatusKey;
  statusLabel: string;
  statusClassName: string;
  driverKind: AdminScheduledDriverKind;
  driverId: string | null;
  driverDisplayName: string | null;
  driverBadge: 'PRE-CONFIRMED' | null;
  /** Live Scheduled Rides board only — not Active Trips / Missed / Cancelled. */
  belongsOnLiveScheduledBoard: boolean;
};

const TERMINAL_TRIP_STATUSES = new Set([
  'completed',
  'cancelled',
  'customer_cancelled',
  'driver_cancelled',
  'expired',
  'expired_no_driver',
  'no_show',
  'declined',
]);

const TERMINAL_SCHEDULED_STATUSES = new Set([
  'cancelled',
  'expired',
  'no_driver_found',
]);

const FINDING_SCHEDULED_STATUSES = new Set([
  'broadcasting',
  'dispatching',
  'converted_to_instant',
  'awaiting_activation_accept',
  'awaiting_confirmation',
  'offering',
]);

const FINDING_TRIP_STATUSES = new Set([
  'searching',
  'searching_new_driver',
  'offered',
  'offering',
  'broadcasting',
]);

function norm(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

function nonEmptyId(value: string | null | undefined): string | null {
  const id = String(value ?? '').trim();
  return id.length > 0 ? id : null;
}

function formatDriverName(driver: AdminScheduledDriverRef): string | null {
  if (!driver) return null;
  const name = [driver.first_name, driver.last_name]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  return name.length > 0 ? name : null;
}

export function isAdminScheduledTerminal(input: {
  status?: string | null;
  scheduled_status?: string | null;
}): boolean {
  const status = norm(input.status);
  const scheduled = norm(input.scheduled_status);
  return TERMINAL_TRIP_STATUSES.has(status) || TERMINAL_SCHEDULED_STATUSES.has(scheduled);
}

/**
 * Live Scheduled board: still in scheduled lifecycle, not yet an active accepted
 * trip, not terminal. One trip UUID → at most one row (query must not join-duplicate).
 */
export function belongsOnLiveAdminScheduledBoard(input: {
  driver_id?: string | null;
  status?: string | null;
  scheduled_status?: string | null;
}): boolean {
  if (isAdminScheduledTerminal(input)) return false;
  // Active accepted ownership leaves Scheduled → Active Trips.
  if (nonEmptyId(input.driver_id)) return false;
  return true;
}

export function resolveAdminScheduledRidePresentation(
  trip: AdminScheduledRidePresentationInput,
): AdminScheduledRidePresentation {
  const driverId = nonEmptyId(trip.driver_id);
  const confirmedId = nonEmptyId(trip.confirmed_driver_id);
  const scheduled = norm(trip.scheduled_status);
  const status = norm(trip.status);
  const published = Boolean(trip.scheduled_broadcast_at);

  const onBoard = belongsOnLiveAdminScheduledBoard(trip);

  // --- Driver SSOT (ownership only) ---
  let driverKind: AdminScheduledDriverKind = 'unassigned';
  let resolvedDriverId: string | null = null;
  let driverDisplayName: string | null = null;
  let driverBadge: 'PRE-CONFIRMED' | null = null;

  if (driverId) {
    driverKind = 'assigned';
    resolvedDriverId = driverId;
    driverDisplayName = formatDriverName(trip.driver);
  } else if (confirmedId) {
    driverKind = 'pre_confirmed';
    resolvedDriverId = confirmedId;
    driverDisplayName = formatDriverName(trip.confirmed_driver);
    driverBadge = 'PRE-CONFIRMED';
  }

  // --- Status SSOT (paired with driver ownership) ---
  let statusKey: AdminScheduledStatusKey;
  let statusLabel: string;
  let statusClassName: string;

  if (status === 'expired' || status === 'expired_no_driver' || scheduled === 'expired' || scheduled === 'no_driver_found') {
    statusKey = 'expired';
    statusLabel = 'Expired';
    statusClassName = 'bg-rose-100 text-rose-800';
  } else if (
    status === 'cancelled' ||
    status === 'customer_cancelled' ||
    status === 'driver_cancelled' ||
    scheduled === 'cancelled'
  ) {
    statusKey = 'cancelled';
    statusLabel = 'Cancelled';
    statusClassName = 'bg-gray-100 text-gray-700';
  } else if (driverId) {
    statusKey = 'driver_assigned';
    statusLabel = 'Driver Assigned';
    statusClassName = 'bg-green-100 text-green-700';
  } else if (confirmedId) {
    statusKey = 'pre_confirmed';
    statusLabel = 'Pre-confirmed';
    statusClassName = 'bg-emerald-100 text-emerald-800';
  } else if (scheduled === 'awaiting_activation_accept') {
    statusKey = 'awaiting_accept';
    statusLabel = 'Awaiting Accept';
    statusClassName = 'bg-emerald-100 text-emerald-800';
  } else if (
    FINDING_SCHEDULED_STATUSES.has(scheduled) ||
    FINDING_TRIP_STATUSES.has(status)
  ) {
    statusKey = 'finding_driver';
    statusLabel = 'Finding Driver';
    statusClassName = 'bg-blue-100 text-blue-700';
  } else if (scheduled === 'admin_held') {
    statusKey = 'held';
    statusLabel = 'Held';
    statusClassName = 'bg-amber-100 text-amber-800';
  } else if (
    published &&
    (scheduled === 'scheduled' || scheduled === 'pending' || scheduled === '')
  ) {
    statusKey = 'available';
    statusLabel = 'Available';
    statusClassName = 'bg-indigo-100 text-indigo-700';
  } else if (scheduled === 'scheduled' || scheduled === 'pending') {
    // Unpublished scheduled row (legacy) — treat as Held-equivalent board state.
    statusKey = 'held';
    statusLabel = 'Held';
    statusClassName = 'bg-amber-100 text-amber-800';
  } else {
    statusKey = 'finding_driver';
    statusLabel = 'Finding Driver';
    statusClassName = 'bg-blue-100 text-blue-700';
  }

  return {
    statusKey,
    statusLabel,
    statusClassName,
    driverKind,
    driverId: resolvedDriverId,
    driverDisplayName,
    driverBadge,
    belongsOnLiveScheduledBoard: onBoard,
  };
}

/** Time cue only — never a lifecycle status. Overdue is forbidden on the live board. */
export function resolveAdminScheduledTimeCue(scheduledAt: string | null | undefined): {
  label: 'Today' | 'Tomorrow' | 'Upcoming' | 'No Date';
  className: string;
  urgent: boolean;
} {
  if (!scheduledAt) {
    return { label: 'No Date', className: 'bg-gray-100 text-gray-700', urgent: false };
  }
  const date = new Date(scheduledAt);
  if (!Number.isFinite(date.getTime())) {
    return { label: 'No Date', className: 'bg-gray-100 text-gray-700', urgent: false };
  }
  // Past pickup must not invent an "Overdue" lifecycle — board should already
  // have moved the row via accept / expire / cancel. Show neutral Upcoming cue.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  const startOfDayAfter = new Date(startOfTomorrow);
  startOfDayAfter.setDate(startOfDayAfter.getDate() + 1);

  if (date >= startOfToday && date < startOfTomorrow) {
    return { label: 'Today', className: 'bg-amber-100 text-amber-700', urgent: true };
  }
  if (date >= startOfTomorrow && date < startOfDayAfter) {
    return { label: 'Tomorrow', className: 'bg-blue-100 text-blue-700', urgent: false };
  }
  return { label: 'Upcoming', className: 'bg-green-100 text-green-700', urgent: false };
}
