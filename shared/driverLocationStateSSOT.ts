/**
 * Driver location state SSOT (P0 frozen-driver fix, audit: Ahmed Osman).
 *
 * Mirrors supabase/migrations/20260910120000_driver_location_frozen_ssot.sql
 * (public.driver_location_thresholds() / public.driver_location_state()) so
 * every consumer that cannot afford a per-driver RPC round trip in a hot path
 * (auto-dispatch, find-drivers Edge functions) can derive the identical
 * status from the same raw driver_presence / drivers columns.
 *
 * KEEP THESE THRESHOLDS IN SYNC WITH THE SQL FUNCTION. They are duplicated
 * (not fetched at runtime) because both consumers filter dozens/hundreds of
 * candidate drivers per request and a per-row RPC call would be too slow.
 * A drift test (driverLocationStateSSOT.test.ts) documents the exact values
 * that must match — update both places together.
 */

export type DriverLocationState =
  | "location_live"
  | "location_stationary"
  | "location_frozen"
  | "location_stale"
  | "location_unavailable";

export const DRIVER_LOCATION_THRESHOLDS = {
  /** Heartbeat (liveness) freshness window, seconds. */
  heartbeatFreshSeconds: 45,
  /** Genuine GPS sample freshness window, seconds. */
  gpsFreshSeconds: 60,
  /** Below this speed (m/s) a driver with fresh GPS is "stationary" not "live". */
  stationarySpeedMps: 0.8,
} as const;

export type DriverLocationStateInput = {
  driverOnlineIntent: boolean | null | undefined;
  lastHeartbeatAt: string | number | Date | null | undefined;
  lastGpsSampleAt: string | number | Date | null | undefined;
  speed?: number | null;
  /** Injectable for tests; defaults to the current time. */
  now?: Date;
};

function toMs(value: string | number | Date | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Derives location_live | location_stationary | location_frozen |
 * location_stale | location_unavailable — identical precedence to the SQL
 * driver_location_state() function.
 *
 * location_frozen: heartbeat is fresh (device/app alive) but no genuine GPS
 * sample has landed within gpsFreshSeconds — the exact "frozen driver" bug
 * pattern (cached coords republished as heartbeat while the real fix stalls).
 */
export function computeDriverLocationState(
  input: DriverLocationStateInput,
): DriverLocationState {
  const nowMs = (input.now ?? new Date()).getTime();
  const heartbeatMs = toMs(input.lastHeartbeatAt);
  const gpsSampleMs = toMs(input.lastGpsSampleAt);

  if (!input.driverOnlineIntent) return "location_unavailable";
  if (heartbeatMs == null) return "location_unavailable";
  if (nowMs - heartbeatMs > DRIVER_LOCATION_THRESHOLDS.heartbeatFreshSeconds * 1000) {
    return "location_stale";
  }
  if (gpsSampleMs == null) return "location_unavailable";
  if (nowMs - gpsSampleMs > DRIVER_LOCATION_THRESHOLDS.gpsFreshSeconds * 1000) {
    return "location_frozen";
  }
  if ((input.speed ?? 0) < DRIVER_LOCATION_THRESHOLDS.stationarySpeedMps) {
    return "location_stationary";
  }
  return "location_live";
}

export function isDriverLocationFrozen(input: DriverLocationStateInput): boolean {
  return computeDriverLocationState(input) === "location_frozen";
}

/** Admin Live Fleet visible status set (audit item #7) — collapses the 5
 * internal location states + online/offline into exactly the 5 labels ops
 * should see: Live | Stationary | Frozen | Delayed | Offline. */
export type DriverFleetDisplayStatus =
  | "Live"
  | "Stationary"
  | "Frozen"
  | "Delayed"
  | "Offline";

export type DriverFleetDisplayStatusInput = DriverLocationStateInput & {
  /** drivers.is_online (effective availability) — takes precedence over location state. */
  isOnline: boolean | null | undefined;
};

export function resolveDriverFleetDisplayStatus(
  input: DriverFleetDisplayStatusInput,
): DriverFleetDisplayStatus {
  if (!input.isOnline) return "Offline";
  switch (computeDriverLocationState(input)) {
    case "location_live":
      return "Live";
    case "location_stationary":
      return "Stationary";
    case "location_frozen":
      return "Frozen";
    case "location_stale":
    case "location_unavailable":
    default:
      return "Delayed";
  }
}
