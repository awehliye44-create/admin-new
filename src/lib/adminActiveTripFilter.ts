/**
 * Admin Active Trips visibility — excludes stale searching rows past search_cycle_expires_at
 * (trips.searching_expires_at). Backend sweep should terminalize these; this is defense-in-depth.
 */

export const ADMIN_SEARCHING_TRIP_STATUSES = [
  'pending',
  'searching',
  'offered',
  'offering',
  'broadcasting',
  'searching_new_driver',
] as const;

export type AdminTripSearchTiming = {
  status?: string | null;
  searching_expires_at?: string | null;
  created_at?: string | null;
  driver_id?: string | null;
};

function normalizeStatus(status: string | null | undefined): string {
  return (status ?? '').trim().toLowerCase();
}

function isAdminSearchingStatus(status: string): boolean {
  return (ADMIN_SEARCHING_TRIP_STATUSES as readonly string[]).includes(status);
}

function formatDurationMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  return `${sec}s`;
}

/** Resolve search deadline from backend searching_expires_at (search_cycle_expires_at SSOT). */
export function resolveAdminSearchDeadlineMs(
  trip: AdminTripSearchTiming | null | undefined,
): number | null {
  if (!trip) return null;
  const status = normalizeStatus(trip.status);
  if (!isAdminSearchingStatus(status)) return null;
  if (trip.driver_id) return null;

  if (trip.searching_expires_at) {
    const ms = new Date(trip.searching_expires_at).getTime();
    if (Number.isFinite(ms)) return ms;
  }

  return null;
}

/** Search countdown for unassigned searching trips; trip age for assigned/in-progress rows. */
export function formatAdminActiveTripTimerLabel(
  trip: AdminTripSearchTiming | null | undefined,
  nowMs = Date.now(),
): string {
  if (!trip) return '—';

  const status = normalizeStatus(trip.status);
  const searching = isAdminSearchingStatus(status) && !trip.driver_id;

  if (searching) {
    const deadlineMs = resolveAdminSearchDeadlineMs(trip);
    if (deadlineMs == null) return 'searching';
    if (nowMs >= deadlineMs) return 'search expired';
    return `${formatDurationMs(deadlineMs - nowMs)} left`;
  }

  if (trip.created_at) {
    const created = new Date(trip.created_at).getTime();
    if (Number.isFinite(created)) {
      return `${formatDurationMs(nowMs - created)} trip age`;
    }
  }

  return '—';
}

export function isAdminStaleSearchingTrip(
  trip: AdminTripSearchTiming | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!trip) return false;
  const status = normalizeStatus(trip.status);
  if (!isAdminSearchingStatus(status) || trip.driver_id) return false;

  const deadlineMs = resolveAdminSearchDeadlineMs(trip);
  if (deadlineMs == null) return false;
  return nowMs >= deadlineMs;
}

export function filterAdminActiveTrips<T extends AdminTripSearchTiming>(
  trips: T[],
  nowMs = Date.now(),
): T[] {
  return trips.filter((trip) => {
    if (isAdminStaleSearchingTrip(trip, nowMs)) {
      console.info('ADMIN_ACTIVE_TRIP_EXCLUDED_EXPIRED_SEARCH', {
        trip_code: (trip as { trip_code?: string | null }).trip_code ?? null,
        status: trip.status ?? null,
        searching_expires_at: trip.searching_expires_at ?? null,
      });
      return false;
    }
    return true;
  });
}

export function countAdminActiveTrips<T extends AdminTripSearchTiming>(
  trips: T[],
  nowMs = Date.now(),
): number {
  return filterAdminActiveTrips(trips, nowMs).length;
}
