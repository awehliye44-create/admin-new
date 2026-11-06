/**
 * auto-dispatch is service-role only. Rate-limit by trip (+ isolate-global ceiling),
 * never by shared egress IP — expire-offers edge-to-edge would otherwise share one
 * 100/min bucket and stall wave advances under concurrent searching trips.
 */

import type { RateLimitConfig } from "./security.ts";

/** Per-trip ceiling: blocks a single trip storm without capping fleet-wide waves. */
export const AUTO_DISPATCH_PER_TRIP_RATE_LIMIT: RateLimitConfig = {
  limit: 30,
  windowMs: 60_000,
  keyPrefix: "auto-dispatch:trip",
};

/**
 * Per-isolate global ceiling for authenticated service-role invokes.
 * Sized above expire-offers rebroadcast concurrency × cron ticks.
 */
export const AUTO_DISPATCH_SERVICE_GLOBAL_RATE_LIMIT: RateLimitConfig = {
  limit: 600,
  windowMs: 60_000,
  keyPrefix: "auto-dispatch:service",
};

export const AUTO_DISPATCH_SERVICE_GLOBAL_RL_ID = "global";

export function autoDispatchTripRateLimitId(tripId: unknown): string {
  if (typeof tripId === "string" && tripId.trim()) return tripId.trim();
  return "missing-trip-id";
}
