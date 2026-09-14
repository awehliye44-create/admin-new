/**
 * NRO-1 — MK-260914-003 driver 56136f5f had app_state=background and an
 * inactive iOS token (device_unbound_logout). No driver_active_devices row.
 * Eligibility treated that row as registered_native_push and created an offer.
 * Send correctly found no authoritative token. A stale socket is not proof.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  classifyNroPushSkip,
  evaluateDispatchableReadiness,
  indexAuthoritativeDriverPushTokens,
  nroDeliveryIsPushReady,
} from "./dispatchEligibilityPolicy.ts";

const DRIVER = "56136f5f-1a3a-4a14-bb23-439b3951415a";

Deno.test("missing active device is not an authoritative push token", () => {
  const map = indexAuthoritativeDriverPushTokens(
    [
      {
        driver_id: DRIVER,
        platform: "android",
        updated_at: "2026-09-14T07:00:00.000Z",
        is_active: true,
        device_id: "android-session-1",
      },
    ],
    [],
  );
  assertEquals(map.has(DRIVER), false);
});

Deno.test("inactive iOS token is not an authoritative Android push token", () => {
  const map = indexAuthoritativeDriverPushTokens(
    [
      {
        driver_id: DRIVER,
        platform: "ios",
        updated_at: "2026-09-07T18:52:30.731Z",
        is_active: false,
        device_id: "ios-430b-unbound",
      },
    ],
    [],
  );
  assertEquals(map.get(DRIVER), undefined);
});

Deno.test("active Android token on the claimed device replaces inactive iOS", () => {
  const map = indexAuthoritativeDriverPushTokens(
    [
      {
        driver_id: DRIVER,
        platform: "ios",
        updated_at: "2026-09-07T18:52:30.731Z",
        is_active: false,
        device_id: "ios-430b-unbound",
      },
      {
        driver_id: DRIVER,
        platform: "android",
        updated_at: "2026-09-14T07:00:00.000Z",
        is_active: true,
        device_id: "android-session-1",
      },
    ],
    [{ driver_id: DRIVER, device_id: "android-session-1" }],
  );
  assertEquals(map.get(DRIVER)?.map((row) => row.platform), ["android"]);
});

Deno.test("different live device is not stolen as this session's push token", () => {
  const map = indexAuthoritativeDriverPushTokens(
    [
      {
        driver_id: DRIVER,
        platform: "android",
        updated_at: "2026-09-14T07:00:00.000Z",
        is_active: true,
        device_id: "other-phone",
      },
    ],
    [{ driver_id: DRIVER, device_id: "this-session" }],
  );
  assertEquals(map.has(DRIVER), false);
});

Deno.test("MK-260914-003: stale heartbeat + inactive token is not dispatchable via socket", () => {
  const readiness = evaluateDispatchableReadiness({
    healthIssuesRaw: ["stale_heartbeat", "realtime_unhealthy", "stale_location"],
    driverOnlineIntent: true,
    isOnline: true,
    hasRegisteredPushToken: false,
    hasRealtimeFresh: false,
    hasCoords: true,
    appState: "background",
  });
  assertEquals(readiness.eligible, false);
  assertEquals(readiness.hardRejectReason, "no_socket_no_push");

  const proof = nroDeliveryIsPushReady({
    hasAuthoritativePushToken: false,
    socketConnected: null,
    socketFresh: false,
  });
  assertEquals(proof.pushReady, false);
  assertEquals(proof.proof, "none");
});

Deno.test("logout-unbound token is not a trusted endpoint", () => {
  const reason = classifyNroPushSkip({
    tokens: [
      {
        driver_id: DRIVER,
        platform: "ios",
        updated_at: "2026-09-07T18:52:30.731Z",
        is_active: false,
        device_id: "ios-430b-unbound",
        last_failure_reason: "device_unbound_logout",
      },
    ],
    activeDeviceId: null,
  });
  assertEquals(reason, "push_skipped_no_active_device");
});

Deno.test("claimed device with only an inactive token is push_skipped_inactive_token", () => {
  const reason = classifyNroPushSkip({
    tokens: [
      {
        driver_id: DRIVER,
        platform: "android",
        updated_at: "2026-09-14T07:00:00.000Z",
        is_active: false,
        device_id: "android-session-1",
        last_failure_reason: "device_unbound_logout",
      },
    ],
    activeDeviceId: "android-session-1",
  });
  assertEquals(reason, "push_skipped_inactive_token");
});

Deno.test("token on another live device is not stolen", () => {
  const reason = classifyNroPushSkip({
    tokens: [
      {
        driver_id: DRIVER,
        platform: "android",
        updated_at: "2026-09-14T07:00:00.000Z",
        is_active: true,
        device_id: "other-phone",
      },
    ],
    activeDeviceId: "this-session",
  });
  assertEquals(reason, "push_skipped_token_device_mismatch");
});

Deno.test("claimed device with no token row is push_skipped_no_active_token", () => {
  const reason = classifyNroPushSkip({
    tokens: [],
    activeDeviceId: "android-session-1",
  });
  assertEquals(reason, "push_skipped_no_active_token");
});

Deno.test("stale socket does not prove NRO push readiness", () => {
  const proof = nroDeliveryIsPushReady({
    hasAuthoritativePushToken: false,
    socketConnected: true,
    socketFresh: false,
  });
  assertEquals(proof.pushReady, false);
  assertEquals(proof.proof, "none");
});
