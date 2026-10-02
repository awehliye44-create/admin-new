/**
 * Trip-modification navigation / fare impact helpers.
 *
 * Approved ONECAB policy (2026-08): Customer trip modifications are applied
 * authoritatively by the backend. The Driver is informed via heads-up only —
 * Driver approval/rejection is NOT required and must not gate application.
 *
 * `computeRequiresDriverApproval` remains exported for Edge import compatibility
 * but always returns false so `request-trip-modification` never creates
 * `pending_driver_approval` from this gate.
 */

export type ModStop = {
  type?: string | null;
  stop_index?: number | null;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  status?: string | null;
};

export type ModChangeType = "add_stop" | "remove_stop" | "change_dropoff" | "reorder_stops" | string;

const PRE_PICKUP_STATUSES = new Set([
  "pending",
  "searching",
  "offered",
  "broadcasting",
  "accepted",
  "confirmed",
  "driver_assigned",
  "en_route",
  "en_route_to_pickup",
  "enroute_to_pickup",
  "driver_en_route",
  "driver_arriving",
]);

/** @deprecated Legacy thresholds — unused while Driver approval is disabled. */
export const DRIVER_APPROVAL_FARE_DELTA_PENCE = 100;
/** @deprecated Legacy thresholds — unused while Driver approval is disabled. */
export const DRIVER_APPROVAL_DISTANCE_METERS = 500;
/** @deprecated Legacy thresholds — unused while Driver approval is disabled. */
export const DRIVER_APPROVAL_DURATION_SECONDS = 120;

function sortStops(stops: ModStop[]): ModStop[] {
  return [...stops].sort((a, b) => (a.stop_index ?? 0) - (b.stop_index ?? 0));
}

function isStopLocked(stop: ModStop): boolean {
  const s = String(stop.status ?? "").toLowerCase();
  return s === "completed" || s === "skipped" || s === "arrived" || s === "departed";
}

export function getCurrentNavStop(stops: ModStop[], tripStatus: string): ModStop | null {
  const sorted = sortStops(stops);
  if (PRE_PICKUP_STATUSES.has(String(tripStatus ?? "").toLowerCase())) {
    return sorted.find((s) => s.type === "pickup") ?? sorted[0] ?? null;
  }
  return (
    sorted.find((s) => s.type !== "pickup" && !isStopLocked(s))
    ?? sorted.find((s) => s.type === "dropoff")
    ?? null
  );
}

export function sameStopIdentity(a: ModStop | null, b: ModStop | null): boolean {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if ((a.stop_index ?? -1) !== (b.stop_index ?? -1)) return false;
  if (String(a.address ?? "") !== String(b.address ?? "")) return false;
  const latDiff = Math.abs(Number(a.lat ?? 0) - Number(b.lat ?? 0));
  const lngDiff = Math.abs(Number(a.lng ?? 0) - Number(b.lng ?? 0));
  return latDiff < 1e-5 && lngDiff < 1e-5;
}

/**
 * Legacy name retained for `request-trip-modification` imports.
 * Always false — Driver approval/rejection is not part of the workflow.
 */
export function computeRequiresDriverApproval(_args: {
  changeType: ModChangeType;
  beforeStops: ModStop[];
  afterStops: ModStop[];
  tripStatus: string;
  fareDeltaPence: number;
  beforeDistanceMeters: number | null;
  afterDistanceMeters: number | null;
  beforeDurationSeconds: number | null;
  afterDurationSeconds: number | null;
}): boolean {
  return false;
}

/**
 * Whether the active navigation target identity changed (informational /
 * route-impact only — does not require Driver approval).
 */
export function computeNavigationTargetChanged(args: {
  changeType: ModChangeType;
  beforeStops: ModStop[];
  afterStops: ModStop[];
  tripStatus: string;
}): boolean {
  const beforeNav = getCurrentNavStop(args.beforeStops, args.tripStatus);
  const afterNav = getCurrentNavStop(args.afterStops, args.tripStatus);
  if (args.changeType === "remove_stop") {
    return !beforeNav || !afterNav || !sameStopIdentity(beforeNav, afterNav);
  }
  return !beforeNav || !afterNav || !sameStopIdentity(beforeNav, afterNav);
}
