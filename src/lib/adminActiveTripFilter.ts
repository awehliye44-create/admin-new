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

const DEFAULT_SEARCH_WINDOW_MS = 3 * 60 * 1000;

function normalizeStatus(status: string | null | undefined): string {
  return (status ?? '').trim().toLowerCase();
}

function isAdminSearchingStatus(status: string): boolean {
  return (ADMIN_SEARCHING_TRIP_STATUSES as readonly string[]).includes(status);
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

  if (trip.created_at) {
    const created = new Date(trip.created_at).getTime();
    if (Number.isFinite(created)) return created + DEFAULT_SEARCH_WINDOW_MS;
  }

  return null;
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
