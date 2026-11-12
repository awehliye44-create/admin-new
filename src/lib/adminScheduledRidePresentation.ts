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
 * Never invent a generic "Pending" label for unknown combinations.
 * Never show "Heading to pickup" before successful departure acknowledgement.
 */

import {
  belongsOnLiveAdminScheduledBoard,
  isAdminScheduledTerminal,
} from '@/lib/adminScheduledBoardMembership';
import { resolveManualInterventionRequired } from '@/lib/adminScheduledRideMonitoring';

export type AdminScheduledDriverKind = 'unassigned' | 'pre_confirmed' | 'assigned';

export type AdminScheduledStatusKey =
  | 'awaiting_publication'
  | 'held'
  | 'available'
  | 'pre_confirmed'
  | 'jit_pending'
  | 'compatible_journey'
  | 'alert_pending'
  | 'alert_acked'
  | 'heading_to_pickup'
  | 'alert_timeout'
  | 'converted_to_instant'
  | 'finding_driver'
  | 'driver_assigned'
  | 'active_pickup'
  | 'payment_blocked'
  | 'needs_attention'
  | 'expired'
  | 'cancelled'
  | 'awaiting_accept'
  | 'unmapped';

export type AdminScheduledDriverRef = {
  id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
} | null | undefined;

export type AdminScheduledRidePresentationInput = {
  id?: string | null;
  is_scheduled?: boolean | null;
  driver_id?: string | null;
  confirmed_driver_id?: string | null;
  scheduled_status?: string | null;
  status?: string | null;
  scheduled_broadcast_at?: string | null;
  scheduled_at?: string | null;
  scheduled_ack_status?: string | null;
  scheduled_ack_deadline_at?: string | null;
  scheduled_hold_reason?: string | null;
  scheduled_publish_attempts?: number | null;
  excluded_driver_ids?: string[] | null;
  payment_state?: string | null;
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
  belongsOnLiveScheduledBoard: boolean;
  needsAttention: boolean;
  unmapped?: boolean;
};

const FINDING_TRIP_STATUSES = new Set([
  'searching',
  'searching_new_driver',
  'offered',
  'offering',
  'broadcasting',
  'pending',
]);

const HEADING_STATUSES = new Set([
  'driver_en_route',
  'en_route_to_pickup',
  'arrived',
]);

const ACTIVE_PICKUP_STATUSES = new Set([
  'in_progress',
  'passenger_on_board',
  'trip_started',
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

export { belongsOnLiveAdminScheduledBoard, isAdminScheduledTerminal };

export function resolveAdminScheduledRidePresentation(
  trip: AdminScheduledRidePresentationInput,
): AdminScheduledRidePresentation {
  const driverId = nonEmptyId(trip.driver_id);
  const confirmedId = nonEmptyId(trip.confirmed_driver_id);
  const scheduled = norm(trip.scheduled_status);
  const status = norm(trip.status);
  const ack = norm(trip.scheduled_ack_status);
  const broadcastMs = trip.scheduled_broadcast_at
    ? Date.parse(String(trip.scheduled_broadcast_at))
    : NaN;
  // Marketplace open only when broadcast_at is due — future ideal-anchor stamps are not Requested.
  const marketplaceOpen = Number.isFinite(broadcastMs) && broadcastMs <= Date.now();
  const published = marketplaceOpen;
  const holdReason = norm(trip.scheduled_hold_reason);

  const onBoard = belongsOnLiveAdminScheduledBoard({
    is_scheduled: trip.is_scheduled ?? true,
    driver_id: trip.driver_id,
    status: trip.status,
    scheduled_status: trip.scheduled_status,
  });

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

  let statusKey: AdminScheduledStatusKey;
  let statusLabel: string;
  let statusClassName: string;
  let unmapped = false;

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
  } else if (holdReason === 'publication_exhausted') {
    statusKey = 'needs_attention';
    statusLabel = 'Publication exhausted';
    statusClassName = 'bg-rose-100 text-rose-900';
  } else if (holdReason === 'payment_gate' || scheduled === 'payment_gate_blocked') {
    statusKey = 'payment_blocked';
    statusLabel = 'Payment blocked';
    statusClassName = 'bg-orange-100 text-orange-900';
  } else if (holdReason === 'airport_pricing') {
    statusKey = 'needs_attention';
    statusLabel = 'Airport pricing exception';
    statusClassName = 'bg-amber-100 text-amber-900';
  } else if (
    holdReason === 'admin_exceptional' ||
    holdReason === 'manual' ||
    holdReason === 'manual_trip'
  ) {
    statusKey = 'needs_attention';
    statusLabel = 'Exceptional hold';
    statusClassName = 'bg-amber-100 text-amber-900';
  } else if (ack === 'pending') {
    // Strict 45s window — never "Heading to pickup" before successful ack.
    statusKey = 'alert_pending';
    statusLabel = 'Awaiting departure';
    statusClassName = 'bg-amber-100 text-amber-900';
  } else if (ack === 'acknowledged' && ACTIVE_PICKUP_STATUSES.has(status)) {
    statusKey = 'active_pickup';
    statusLabel = 'Active pickup';
    statusClassName = 'bg-green-100 text-green-800';
  } else if (ack === 'acknowledged' && HEADING_STATUSES.has(status)) {
    statusKey = 'heading_to_pickup';
    statusLabel = 'Driver heading to pickup';
    statusClassName = 'bg-green-100 text-green-800';
  } else if (ack === 'acknowledged') {
    statusKey = 'alert_acked';
    statusLabel = 'Departure acknowledged';
    statusClassName = 'bg-emerald-100 text-emerald-900';
  } else if (ack === 'timed_out') {
    statusKey = 'alert_timeout';
    statusLabel = 'Ack timeout';
    statusClassName = 'bg-rose-100 text-rose-900';
  } else if (
    scheduled === 'converted_to_instant' &&
    (FINDING_TRIP_STATUSES.has(status) || !driverId)
  ) {
    statusKey = FINDING_TRIP_STATUSES.has(status) ? 'finding_driver' : 'converted_to_instant';
    statusLabel = FINDING_TRIP_STATUSES.has(status)
      ? 'Automatic fallback dispatch'
      : 'Converted to instant';
    statusClassName = 'bg-blue-100 text-blue-800';
  } else if (
    FINDING_TRIP_STATUSES.has(status) ||
    scheduled === 'broadcasting' ||
    scheduled === 'dispatching' ||
    scheduled === 'offering'
  ) {
    statusKey = 'finding_driver';
    statusLabel = 'Automatic fallback dispatch';
    statusClassName = 'bg-blue-100 text-blue-700';
  } else if (driverId && ACTIVE_PICKUP_STATUSES.has(status)) {
    statusKey = 'active_pickup';
    statusLabel = 'Active pickup';
    statusClassName = 'bg-green-100 text-green-800';
  } else if (driverId && HEADING_STATUSES.has(status) && ack !== 'acknowledged') {
    // Safety: en_route without successful ack must not read as Heading to pickup.
    statusKey = 'driver_assigned';
    statusLabel = 'Driver Assigned';
    statusClassName = 'bg-green-100 text-green-700';
  } else if (driverId) {
    statusKey = 'driver_assigned';
    statusLabel = 'Driver Assigned';
    statusClassName = 'bg-green-100 text-green-700';
  } else if (
    confirmedId &&
    (scheduled === 'awaiting_activation_accept' || scheduled === 'awaiting_confirmation') &&
    !ack
  ) {
    statusKey = 'jit_pending';
    statusLabel = 'JIT pending';
    statusClassName = 'bg-violet-100 text-violet-900';
  } else if (confirmedId && !ack) {
    statusKey = 'pre_confirmed';
    statusLabel = 'Confirmed — driver accepted';
    statusClassName = 'bg-emerald-100 text-emerald-800';
  } else if (scheduled === 'awaiting_activation_accept') {
    statusKey = 'awaiting_accept';
    statusLabel = 'Awaiting Accept';
    statusClassName = 'bg-emerald-100 text-emerald-800';
  } else if (
    (scheduled === 'admin_held' || scheduled === 'scheduled' || scheduled === 'pending' || scheduled === '') &&
    !published &&
    (holdReason === 'publication_pending' ||
      holdReason === 'publication_retry' ||
      holdReason === '' ||
      Number.isFinite(broadcastMs))
  ) {
    statusKey = 'awaiting_publication';
    statusLabel = 'Awaiting automatic publication';
    statusClassName = 'bg-slate-100 text-slate-800';
  } else if (scheduled === 'admin_held') {
    statusKey = holdReason && holdReason !== 'admin_manual' ? 'needs_attention' : 'held';
    statusLabel = statusKey === 'needs_attention' ? 'Needs attention' : 'Held';
    statusClassName = 'bg-amber-100 text-amber-800';
  } else if (
    published &&
    (scheduled === 'scheduled' || scheduled === 'pending' || scheduled === '')
  ) {
    statusKey = 'available';
    statusLabel = 'Requested — available in Scheduled Jobs';
    statusClassName = 'bg-indigo-100 text-indigo-700';
  } else if (scheduled === 'scheduled' || scheduled === 'pending' || scheduled === '') {
    statusKey = 'awaiting_publication';
    statusLabel = 'Awaiting automatic publication';
    statusClassName = 'bg-slate-100 text-slate-800';
  } else {
    unmapped = true;
    statusKey = 'unmapped';
    statusLabel = `Unmapped (${scheduled || '—'} / ${status || '—'})`;
    statusClassName = 'bg-rose-100 text-rose-900';
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('[adminScheduledRidePresentation] unmapped scheduled presentation', {
        id: trip.id ?? null,
        scheduled_status: trip.scheduled_status ?? null,
        status: trip.status ?? null,
        driver_id: trip.driver_id ?? null,
        confirmed_driver_id: trip.confirmed_driver_id ?? null,
        scheduled_ack_status: trip.scheduled_ack_status ?? null,
      });
    }
  }

  const needsAttention =
    unmapped ||
    resolveManualInterventionRequired({
      status: trip.status,
      scheduled_status: trip.scheduled_status,
      scheduled_hold_reason: trip.scheduled_hold_reason,
      scheduled_ack_status: trip.scheduled_ack_status,
      scheduled_publish_attempts: trip.scheduled_publish_attempts,
    });

  return {
    statusKey,
    statusLabel,
    statusClassName,
    driverKind,
    driverId: resolvedDriverId,
    driverDisplayName,
    driverBadge,
    belongsOnLiveScheduledBoard: onBoard,
    needsAttention,
    unmapped,
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
