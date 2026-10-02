/**
 * Pure helpers for idle driver presence freshness (auto-dispatch).
 * Used by unit tests to lock dispatch semantics without booting Deno.serve.
 */

export function timestampFresh(ts: string | null | undefined, cutoffIso: string): boolean {
  if (!ts) return false;
  return new Date(ts).getTime() >= new Date(cutoffIso).getTime();
}

export function idleRepairCandidate(args: {
  currentTripId: string | null;
  presenceStatus: string;
  heartbeatOk: boolean;
  locationOk: boolean;
  hasLatLng: boolean;
  isOnlineFlag: boolean;
}): boolean {
  if (args.currentTripId) return false;
  if (!args.heartbeatOk || !args.locationOk || !args.hasLatLng) return false;
  const statusBad = args.presenceStatus !== "online";
  const onlineFlagBad = args.isOnlineFlag !== true;
  return statusBad || onlineFlagBad;
}

export function realtimeFresh(
  presence: {
    socket_connected?: boolean | null;
    last_socket_pong_at?: string | null;
    last_realtime_seen_at?: string | null;
    updated_at?: string | null;
  },
  cutoffIso: string,
): boolean {
  if (presence.socket_connected !== true) return false;
  return timestampFresh(
    presence.last_socket_pong_at ?? presence.last_realtime_seen_at ?? presence.updated_at ?? null,
    cutoffIso,
  );
}

/** Max age for realtime socket anchor when gating offer delivery (seconds). */
export const REALTIME_FRESH_MAX_AGE_SECONDS = 90;

export type DriverOfferReachability = {
  reachable: boolean;
  rejectReason: "no_socket_no_push" | null;
  hasRealtimeFresh: boolean;
  hasRegisteredPushToken: boolean;
};

/**
 * Driver can receive an offer when Supabase Realtime is live OR a registered
 * native push token exists. Online-without-either is "false reachable".
 */
export function driverOfferReachable(args: {
  presence: {
    socket_connected?: boolean | null;
    last_socket_pong_at?: string | null;
    last_realtime_seen_at?: string | null;
    updated_at?: string | null;
  };
  hasRegisteredPushToken: boolean;
  realtimeCutoffIso: string;
}): DriverOfferReachability {
  const hasRealtimeFresh = realtimeFresh(args.presence, args.realtimeCutoffIso);
  const hasRegisteredPushToken = args.hasRegisteredPushToken === true;
  const reachable = hasRealtimeFresh || hasRegisteredPushToken;
  return {
    reachable,
    rejectReason: reachable ? null : "no_socket_no_push",
    hasRealtimeFresh,
    hasRegisteredPushToken,
  };
}

/** Wave sizes / TTLs occasionally arrive as numeric strings â parse safely (>0 only). */
export function coercePositiveInt(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return null;
    const n = Number(t);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}
