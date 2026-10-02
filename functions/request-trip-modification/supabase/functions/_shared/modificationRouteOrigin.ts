/**
 * Route origin SSOT for trip modification pricing.
 *
 * A modification is priced as the delta between the remaining route to the old
 * destination and the remaining route to the new one. Both legs must therefore
 * start from where the Driver actually is.
 *
 * Pre-pickup the Driver has not collected the passenger yet, so the whole
 * journey is still ahead and the pickup remains the correct origin.
 *
 * In progress the origin must be a fresh Driver GPS sample. A pending stop or
 * dropoff is a destination, never an origin: using one prices
 * `old destination -> new destination`, a leg the car will never drive, and
 * collapses the "before" leg to 0m (floored to the minimum fare) so every
 * modification looks like an increase.
 */
import { timestampFresh } from "./dispatchGates.ts";

/** Max age of a Driver GPS sample used to price an in-progress modification. */
export const MODIFICATION_ORIGIN_GPS_MAX_AGE_SECONDS = 120;

export type DriverLiveLocationRow = {
  latitude?: number | string | null;
  longitude?: number | string | null;
  gps_recorded_at?: string | null;
};

export type ModificationOriginInput = {
  isPrePickup: boolean;
  pickupLat?: number | string | null;
  pickupLng?: number | string | null;
  liveLocation?: DriverLiveLocationRow | null;
  nowMs: number;
};

export type ModificationOriginFailure =
  | "missing_pickup"
  | "no_live_location"
  | "stale_live_location";

export type ModificationOriginResult =
  | {
    ok: true;
    source: "pickup" | "driver_live_gps";
    lat: number;
    lng: number;
    gpsRecordedAt: string | null;
  }
  | { ok: false; reason: ModificationOriginFailure };

function finiteCoord(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < -180 || n > 180) return null;
  return n;
}

/**
 * Resolve the single frozen origin used for BOTH the before and after route of
 * one modification request. Fails closed rather than approximating.
 */
export function resolveModificationRouteOrigin(
  input: ModificationOriginInput,
): ModificationOriginResult {
  if (input.isPrePickup) {
    const lat = finiteCoord(input.pickupLat);
    const lng = finiteCoord(input.pickupLng);
    if (lat == null || lng == null) return { ok: false, reason: "missing_pickup" };
    return { ok: true, source: "pickup", lat, lng, gpsRecordedAt: null };
  }

  const live = input.liveLocation ?? null;
  const lat = finiteCoord(live?.latitude);
  const lng = finiteCoord(live?.longitude);
  if (live == null || lat == null || lng == null) {
    return { ok: false, reason: "no_live_location" };
  }

  const cutoffIso = new Date(
    input.nowMs - MODIFICATION_ORIGIN_GPS_MAX_AGE_SECONDS * 1000,
  ).toISOString();
  if (!timestampFresh(live.gps_recorded_at ?? null, cutoffIso)) {
    return { ok: false, reason: "stale_live_location" };
  }

  return {
    ok: true,
    source: "driver_live_gps",
    lat,
    lng,
    gpsRecordedAt: live.gps_recorded_at ?? null,
  };
}
