/**
 * B5 — Arrive Pickup / Arrive Stop critical-path trim (flag-gated).
 *
 * Default OFF (`ARRIVE_PICKUP_B5` unset/0). When ON:
 * - Skip redundant post-waiting `trips` SELECT on Arrive when
 *   `waitingResult.startedAt` (or existing trip stamp) already proves
 *   pickup_waiting_started_at — same fail-closed rule as the primary path.
 * - Does not change geofence, dwell, far-from, waiting start RPC, notify, or
 *   duplicate-arrival semantics.
 *
 * Covers manual + automatic Arrive at pickup and intermediate stop paths that
 * share the same post-waiting confirm SELECT pattern.
 */

export const ARRIVE_PICKUP_B5_FLAG = "ARRIVE_PICKUP_B5";

function readArrivePickupB5FlagFromEnv(): string | undefined {
  try {
    if (typeof Deno === "undefined") return undefined;
    return Deno.env.get(ARRIVE_PICKUP_B5_FLAG) ?? undefined;
  } catch {
    return undefined;
  }
}

export function isArrivePickupB5Enabled(
  raw: string | undefined | null = readArrivePickupB5FlagFromEnv(),
): boolean {
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/**
 * Whether the post-waiting trips SELECT is redundant.
 * Never invents a waiting stamp — missing proof → keep SELECT (fail-closed recovery).
 */
export function shouldSkipPostWaitingTripSelect(args: {
  b5Enabled: boolean;
  waitingStartedAt: string | null | undefined;
  tripWaitingStartedAt: string | null | undefined;
}): boolean {
  if (!args.b5Enabled) return false;
  const fromWaiting = String(args.waitingStartedAt ?? "").trim();
  if (fromWaiting) return true;
  const fromTrip = String(args.tripWaitingStartedAt ?? "").trim();
  return Boolean(fromTrip);
}
