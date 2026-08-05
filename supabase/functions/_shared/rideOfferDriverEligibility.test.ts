/**
 * Unit tests for shared ride-offer eligibility + voluntary-decline cooldown helper.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateRideOfferDriverEligibility,
  isVoluntaryDeclineCooldownStatus,
} from "./rideOfferDriverEligibility.ts";

const baseDriver = {
  id: "driver-1",
  driver_status: "active",
  approval_status: "approved",
  documents_approved: true,
  is_online: true,
  driver_online_intent: true,
  current_trip_id: null,
  current_lat: 51.5,
  current_lng: -0.1,
  last_gps_sample_at: new Date().toISOString(),
  speed: 5,
};

const freshHeartbeat = new Date().toISOString();

const basePresence = {
  status: "online",
  lat: 51.5,
  lng: -0.1,
  last_heartbeat_at: freshHeartbeat,
  last_gps_sample_at: freshHeartbeat,
  speed: 5,
  socket_connected: true,
  app_state: "background",
  push_token: null,
};

Deno.test("eligible when online + fresh presence + push token", () => {
  const r = evaluateRideOfferDriverEligibility({
    driver: baseDriver,
    presence: basePresence,
    hasActivePushToken: true,
    presenceMaxAgeSeconds: 90,
  });
  assertEquals(r.eligible, true);
  assertEquals(r.reason, "eligible");
});

Deno.test("hard reject offline driver", () => {
  const r = evaluateRideOfferDriverEligibility({
    driver: { ...baseDriver, is_online: false },
    presence: basePresence,
    hasActivePushToken: true,
    presenceMaxAgeSeconds: 90,
  });
  assertEquals(r.eligible, false);
  assertEquals(r.reason, "driver_offline");
});

Deno.test("hard reject stale heartbeat (not degraded)", () => {
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const r = evaluateRideOfferDriverEligibility({
    driver: baseDriver,
    presence: { ...basePresence, last_heartbeat_at: stale },
    hasActivePushToken: true,
    presenceMaxAgeSeconds: 90,
  });
  assertEquals(r.eligible, false);
  assertEquals(r.reason, "stale_heartbeat");
});

Deno.test("hard reject missing presence row", () => {
  const r = evaluateRideOfferDriverEligibility({
    driver: baseDriver,
    presence: null,
    hasActivePushToken: true,
    presenceMaxAgeSeconds: 90,
  });
  assertEquals(r.eligible, false);
  assertEquals(r.reason, "no_presence_row");
});

Deno.test("hard reject presence_not_online", () => {
  const r = evaluateRideOfferDriverEligibility({
    driver: baseDriver,
    presence: { ...basePresence, status: "offline" },
    hasActivePushToken: true,
    presenceMaxAgeSeconds: 90,
  });
  assertEquals(r.eligible, false);
  assertEquals(r.reason, "presence_not_online");
});

Deno.test("hard reject online_intent_false", () => {
  const r = evaluateRideOfferDriverEligibility({
    driver: { ...baseDriver, driver_online_intent: false },
    presence: basePresence,
    hasActivePushToken: true,
    presenceMaxAgeSeconds: 90,
  });
  assertEquals(r.eligible, false);
  assertEquals(r.reason, "online_intent_false");
});

Deno.test("foreground app_state alone does not make driver ineligible", () => {
  const r = evaluateRideOfferDriverEligibility({
    driver: baseDriver,
    presence: { ...basePresence, app_state: "foreground", socket_connected: false },
    hasActivePushToken: true,
    presenceMaxAgeSeconds: 90,
  });
  assertEquals(r.eligible, true);
  assertEquals(r.presenceAppState, "foreground");
  assertEquals(r.effectiveDeliveryChannel, "push");
});

Deno.test("no push token without healthy foreground realtime → no_delivery_channel", () => {
  const r = evaluateRideOfferDriverEligibility({
    driver: baseDriver,
    presence: {
      ...basePresence,
      app_state: "background",
      socket_connected: false,
    },
    hasActivePushToken: false,
    presenceMaxAgeSeconds: 90,
  });
  assertEquals(r.eligible, false);
  assertEquals(r.reason, "no_delivery_channel");
});

Deno.test("cooldown helper: only declined is voluntary", () => {
  assertEquals(isVoluntaryDeclineCooldownStatus("declined"), true);
  assertEquals(isVoluntaryDeclineCooldownStatus("expired"), false);
  assertEquals(isVoluntaryDeclineCooldownStatus("revoked"), false);
  assertEquals(isVoluntaryDeclineCooldownStatus("pending"), false);
});
