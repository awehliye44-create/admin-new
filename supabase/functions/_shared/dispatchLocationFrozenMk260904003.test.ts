/**
 * MK-260904-003 regression — Android background driver excluded on trip_insert
 * for location_frozen despite fresh heartbeat, then offered after foreground resume.
 *
 * Timing pattern (UTC):
 * - Trip created / wave 1: 2026-09-04 10:39:54
 * - Driver MK0002 heartbeat age 15s, app_state=background, is_online=true
 * - Reject: location_frozen (hard_excluded) — NOT stale_heartbeat
 * - Wave 2 (~10:40:46): app_state=foreground, eligible degraded lost_connection
 *
 * Lock: intentional online + push + coords must remain dispatchable when GPS is
 * frozen/stale; location_frozen is temporary/degradable, not permanent.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  canonicalizeDispatchRejectReason,
  classifyDispatchExclusion,
  DEGRADABLE_HEALTH_REJECT_REASONS,
  evaluateDispatchableReadiness,
  TEMPORARY_DISPATCH_REJECT_REASONS,
} from "./dispatchEligibilityPolicy.ts";
import { evaluateRideOfferDriverEligibility } from "./rideOfferDriverEligibility.ts";
import { computeDriverLocationState } from "./driverLocationState.ts";

const WAVE1_NOW = new Date("2026-09-04T10:39:54.435Z");
const WAVE1_HB = "2026-09-04T10:39:39.173Z"; // age 15s
const WAVE1_GPS = "2026-09-04T10:30:47.198Z"; // ~9m old — location_frozen at 60s TTL

Deno.test("MK-260904-003: computeDriverLocationState is location_frozen (HB fresh, GPS aged)", () => {
  const state = computeDriverLocationState({
    driverOnlineIntent: true,
    lastHeartbeatAt: WAVE1_HB,
    lastGpsSampleAt: WAVE1_GPS,
    speed: 0,
    now: WAVE1_NOW,
  });
  assertEquals(state, "location_frozen");
});

Deno.test("MK-260904-003: location_frozen is temporary + degradable (not permanent offline)", () => {
  assertEquals(TEMPORARY_DISPATCH_REJECT_REASONS.has("location_frozen"), true);
  assertEquals(DEGRADABLE_HEALTH_REJECT_REASONS.has("location_frozen"), true);
  assertEquals(classifyDispatchExclusion("location_frozen"), "temporary");
  assertEquals(
    canonicalizeDispatchRejectReason("location_frozen", {
      driverOnlineIntent: true,
      appState: "background",
    }),
    "location_frozen",
  );
});

Deno.test("MK-260904-003 wave1: online-intent background driver stays dispatchable when GPS frozen", () => {
  const readiness = evaluateDispatchableReadiness({
    healthIssuesRaw: ["stale_location", "location_frozen", "realtime_unhealthy"],
    driverOnlineIntent: true,
    isOnline: true,
    hasRegisteredPushToken: true,
    hasRealtimeFresh: false,
    hasCoords: true,
    appState: "background",
  });
  assertEquals(readiness.eligible, true);
  assertEquals(readiness.degraded, true);
  assertEquals(readiness.hardRejectReason, null);
  assertEquals(readiness.degradedHealthReasons.includes("location_frozen") ||
    readiness.degradedHealthReasons.includes("lost_connection"), true);
});

Deno.test("MK-260904-003 wave1: ride-offer eligibility must not hard-fail location_frozen", () => {
  const result = evaluateRideOfferDriverEligibility({
    driver: {
      id: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
      driver_status: "active",
      approval_status: "approved",
      documents_approved: true,
      is_online: true,
      driver_online_intent: true,
      current_trip_id: null,
      current_lat: 52.059,
      current_lng: -0.634,
      last_gps_sample_at: WAVE1_GPS,
      speed: 0,
    },
    presence: {
      status: "online",
      lat: 52.059,
      lng: -0.634,
      last_heartbeat_at: WAVE1_HB,
      last_gps_sample_at: WAVE1_GPS,
      speed: 0,
      socket_connected: false,
      app_state: "background",
      push_token: "tok",
    },
    hasActivePushToken: true,
    presenceMaxAgeSeconds: 45,
    nowMs: WAVE1_NOW.getTime(),
  });
  assertEquals(result.eligible, true);
  assertEquals(result.reason, "eligible");
});

Deno.test("MK-260904-003: truly offline / no intent still hard-excluded", () => {
  const offline = evaluateDispatchableReadiness({
    healthIssuesRaw: ["location_frozen"],
    driverOnlineIntent: false,
    isOnline: false,
    hasRegisteredPushToken: true,
    hasRealtimeFresh: false,
    hasCoords: true,
    appState: "background",
  });
  assertEquals(offline.eligible, false);

  const noPushNoSocket = evaluateDispatchableReadiness({
    healthIssuesRaw: ["location_frozen", "realtime_unhealthy", "no_registered_push_token"],
    driverOnlineIntent: true,
    isOnline: true,
    hasRegisteredPushToken: false,
    hasRealtimeFresh: false,
    hasCoords: true,
    appState: "background",
  });
  assertEquals(noPushNoSocket.eligible, false);
  assertEquals(noPushNoSocket.hardRejectReason, "no_socket_no_push");
});
