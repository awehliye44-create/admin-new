/**
 * MK-261106-007 — iOS offer card flash then disappear.
 *
 * Prod: driver c40dd8a6 (iOS) selected as dispatchable_degraded with
 * stale_heartbeat + lost_connection; Realtime painted the NRO card; push gate
 * then revoked ineligible_before_push:stale_heartbeat within ~1–2s.
 * Android peer (fresh heartbeat) kept the full ~45s TTL.
 *
 * Locks:
 * - stale_heartbeat is a hard selection reject (not degradable)
 * - push gate must NOT revoke pending offers for stale_heartbeat alone
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  DEGRADABLE_HEALTH_REJECT_REASONS,
  evaluateDispatchableReadiness,
  isPresenceLivenessFresh,
} from "../../functions/_shared/dispatchEligibilityPolicy.ts";
import {
  evaluateRideOfferDriverEligibility,
  shouldRevokeOnRideOfferPushGateSkip,
} from "../../functions/_shared/rideOfferDriverEligibility.ts";

const OFFER_AT = new Date("2026-11-06T11:24:06.943Z");
const STALE_HB = "2026-11-06T09:46:11.577Z";
const STALE_GPS = "2026-11-06T09:45:17.563Z";

Deno.test("MK-261106-007: stale_heartbeat is not degradable", () => {
  assertEquals(DEGRADABLE_HEALTH_REJECT_REASONS.has("stale_heartbeat"), false);
});

Deno.test("MK-261106-007: auto-dispatch readiness hard-rejects stale_heartbeat", () => {
  const readiness = evaluateDispatchableReadiness({
    healthIssuesRaw: ["stale_heartbeat", "lost_connection"],
    driverOnlineIntent: true,
    isOnline: true,
    hasRegisteredPushToken: true,
    hasRealtimeFresh: true,
    hasCoords: true,
    appState: "background",
  });
  assertEquals(readiness.eligible, false);
  assertEquals(readiness.degraded, false);
  assertEquals(readiness.hardRejectReason, "stale_heartbeat");
});

Deno.test("MK-261106-007: push-gate eligibility hard-fails stale_heartbeat", () => {
  const result = evaluateRideOfferDriverEligibility({
    driver: {
      id: "c40dd8a6-f422-40bc-9534-bae7be88b93e",
      driver_status: "active",
      approval_status: "approved",
      documents_approved: true,
      is_online: true,
      driver_online_intent: true,
      current_trip_id: null,
      current_lat: 52.04,
      current_lng: -0.76,
      last_gps_sample_at: STALE_GPS,
      speed: 0,
    },
    presence: {
      status: "online",
      lat: 52.04,
      lng: -0.76,
      last_heartbeat_at: STALE_HB,
      last_gps_sample_at: STALE_GPS,
      speed: 0,
      socket_connected: true,
      app_state: "background",
      push_token: "tok",
    },
    hasActivePushToken: true,
    presenceMaxAgeSeconds: 45,
    nowMs: OFFER_AT.getTime(),
  });
  assertEquals(result.eligible, false);
  assertEquals(result.reason, "stale_heartbeat");
});

Deno.test("MK-261106-007: fresh heartbeat + frozen GPS stays degradable (MK-260904)", () => {
  const readiness = evaluateDispatchableReadiness({
    healthIssuesRaw: ["location_frozen", "stale_location"],
    driverOnlineIntent: true,
    isOnline: true,
    hasRegisteredPushToken: true,
    hasRealtimeFresh: false,
    hasCoords: true,
    appState: "background",
  });
  assertEquals(readiness.eligible, true);
  assertEquals(readiness.degraded, true);
});

Deno.test("MK-261106-007: push-gate skip must not revoke for stale_heartbeat", () => {
  assertEquals(shouldRevokeOnRideOfferPushGateSkip("stale_heartbeat"), false);
  assertEquals(shouldRevokeOnRideOfferPushGateSkip("driver_offline"), true);
  assertEquals(shouldRevokeOnRideOfferPushGateSkip("no_active_push_token"), true);
});

Deno.test("offerability: fresh GPS counts as liveness when heartbeat field is frozen", () => {
  const nowMs = OFFER_AT.getTime();
  assertEquals(
    isPresenceLivenessFresh({
      lastHeartbeatAt: STALE_HB,
      lastGpsSampleAt: "2026-11-06T11:23:50.000Z",
      presenceMaxAgeSeconds: 45,
      nowMs,
    }),
    true,
  );
  assertEquals(
    isPresenceLivenessFresh({
      lastHeartbeatAt: STALE_HB,
      lastGpsSampleAt: STALE_GPS,
      presenceMaxAgeSeconds: 45,
      nowMs,
    }),
    false,
  );

  const eligible = evaluateRideOfferDriverEligibility({
    driver: {
      id: "ios-fresh-gps",
      driver_status: "active",
      approval_status: "approved",
      documents_approved: true,
      is_online: true,
      driver_online_intent: true,
      current_trip_id: null,
      current_lat: 52.04,
      current_lng: -0.76,
      last_gps_sample_at: "2026-11-06T11:23:50.000Z",
      speed: 0,
    },
    presence: {
      status: "online",
      lat: 52.04,
      lng: -0.76,
      last_heartbeat_at: STALE_HB,
      last_gps_sample_at: "2026-11-06T11:23:50.000Z",
      speed: 0,
      socket_connected: true,
      app_state: "background",
      push_token: "tok",
    },
    hasActivePushToken: true,
    presenceMaxAgeSeconds: 45,
    nowMs,
  });
  assertEquals(eligible.eligible, true);
});
