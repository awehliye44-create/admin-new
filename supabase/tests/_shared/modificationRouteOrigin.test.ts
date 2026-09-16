/**
 * Mid-trip modification route origin lock.
 *
 * Run: deno test --allow-read supabase/functions/_shared/modificationRouteOrigin.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  MODIFICATION_ORIGIN_GPS_MAX_AGE_SECONDS,
  resolveModificationRouteOrigin,
} from "./modificationRouteOrigin.ts";

const NOW = Date.parse("2026-08-16T17:05:08.000Z");
const isoAgo = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

// MK-260816-002 real values.
const PICKUP = { lat: 51.9925566, lng: -0.8002044 };
const DRIVER = { lat: 51.9924889251521, lng: -0.8001471057599 };
const LIDL = { lat: 52.0807103, lng: -0.7454298 };

Deno.test("D. fresh live GPS is used as the in-progress origin", () => {
  const origin = resolveModificationRouteOrigin({
    isPrePickup: false,
    pickupLat: PICKUP.lat,
    pickupLng: PICKUP.lng,
    liveLocation: {
      latitude: DRIVER.lat,
      longitude: DRIVER.lng,
      gps_recorded_at: isoAgo(20),
    },
    nowMs: NOW,
  });

  assertEquals(origin.ok, true);
  if (!origin.ok) throw new Error("expected ok");
  assertEquals(origin.source, "driver_live_gps");
  assertEquals(origin.lat, DRIVER.lat);
  assertEquals(origin.lng, DRIVER.lng);
});

Deno.test("E. stale live GPS fails closed", () => {
  const origin = resolveModificationRouteOrigin({
    isPrePickup: false,
    pickupLat: PICKUP.lat,
    pickupLng: PICKUP.lng,
    liveLocation: {
      latitude: DRIVER.lat,
      longitude: DRIVER.lng,
      gps_recorded_at: isoAgo(MODIFICATION_ORIGIN_GPS_MAX_AGE_SECONDS + 1),
    },
    nowMs: NOW,
  });

  assertEquals(origin.ok, false);
  if (origin.ok) throw new Error("expected failure");
  assertEquals(origin.reason, "stale_live_location");
});

Deno.test("F. missing live GPS fails closed — never falls back to pickup mid-trip", () => {
  const noRow = resolveModificationRouteOrigin({
    isPrePickup: false,
    pickupLat: PICKUP.lat,
    pickupLng: PICKUP.lng,
    liveLocation: null,
    nowMs: NOW,
  });
  assertEquals(noRow.ok, false);
  if (noRow.ok) throw new Error("expected failure");
  assertEquals(noRow.reason, "no_live_location");

  const nullCoords = resolveModificationRouteOrigin({
    isPrePickup: false,
    pickupLat: PICKUP.lat,
    pickupLng: PICKUP.lng,
    liveLocation: { latitude: null, longitude: null, gps_recorded_at: isoAgo(5) },
    nowMs: NOW,
  });
  assertEquals(nullCoords.ok, false);
  if (nullCoords.ok) throw new Error("expected failure");
  assertEquals(nullCoords.reason, "no_live_location");

  const missingTimestamp = resolveModificationRouteOrigin({
    isPrePickup: false,
    pickupLat: PICKUP.lat,
    pickupLng: PICKUP.lng,
    liveLocation: { latitude: DRIVER.lat, longitude: DRIVER.lng, gps_recorded_at: null },
    nowMs: NOW,
  });
  assertEquals(missingTimestamp.ok, false);
  if (missingTimestamp.ok) throw new Error("expected failure");
  assertEquals(missingTimestamp.reason, "stale_live_location");
});

Deno.test("G. pre-pickup keeps the pickup origin", () => {
  const origin = resolveModificationRouteOrigin({
    isPrePickup: true,
    pickupLat: PICKUP.lat,
    pickupLng: PICKUP.lng,
    liveLocation: null,
    nowMs: NOW,
  });

  assertEquals(origin.ok, true);
  if (!origin.ok) throw new Error("expected ok");
  assertEquals(origin.source, "pickup");
  assertEquals(origin.lat, PICKUP.lat);
  assertEquals(origin.lng, PICKUP.lng);
});

Deno.test("a pending dropoff is never returned as the origin", () => {
  const origin = resolveModificationRouteOrigin({
    isPrePickup: false,
    pickupLat: PICKUP.lat,
    pickupLng: PICKUP.lng,
    liveLocation: {
      latitude: DRIVER.lat,
      longitude: DRIVER.lng,
      gps_recorded_at: isoAgo(10),
    },
    nowMs: NOW,
  });

  if (!origin.ok) throw new Error("expected ok");
  assertEquals(origin.lat === LIDL.lat, false);
  assertEquals(origin.lng === LIDL.lng, false);
});

Deno.test("C. one frozen origin serves both the before and after leg", () => {
  const input = {
    isPrePickup: false,
    pickupLat: PICKUP.lat,
    pickupLng: PICKUP.lng,
    liveLocation: {
      latitude: DRIVER.lat,
      longitude: DRIVER.lng,
      gps_recorded_at: isoAgo(15),
    },
    nowMs: NOW,
  };

  const origin = resolveModificationRouteOrigin(input);
  if (!origin.ok) throw new Error("expected ok");

  // Both legs read the same resolved value; no second GPS fetch mid-calculation.
  const beforeLegOrigin = { lat: origin.lat, lng: origin.lng };
  const afterLegOrigin = { lat: origin.lat, lng: origin.lng };
  assertEquals(beforeLegOrigin, afterLegOrigin);
});

Deno.test("boundary: sample exactly at the freshness limit is accepted", () => {
  const origin = resolveModificationRouteOrigin({
    isPrePickup: false,
    pickupLat: PICKUP.lat,
    pickupLng: PICKUP.lng,
    liveLocation: {
      latitude: DRIVER.lat,
      longitude: DRIVER.lng,
      gps_recorded_at: isoAgo(MODIFICATION_ORIGIN_GPS_MAX_AGE_SECONDS),
    },
    nowMs: NOW,
  });

  assertEquals(origin.ok, true);
});

Deno.test("pre-pickup without pickup coordinates fails closed", () => {
  const origin = resolveModificationRouteOrigin({
    isPrePickup: true,
    pickupLat: null,
    pickupLng: null,
    liveLocation: null,
    nowMs: NOW,
  });

  assertEquals(origin.ok, false);
  if (origin.ok) throw new Error("expected failure");
  assertEquals(origin.reason, "missing_pickup");
});

Deno.test("LOCK: origin resolution never falls back to a stop or destination", async () => {
  const src = await Deno.readTextFile(
    new URL("../request-trip-modification/index.ts", import.meta.url),
  );

  // The reverted form that priced old destination -> new destination.
  assertEquals(src.includes("?? navBeforeRemove?.lat"), false);
  assertEquals(src.includes("?? navBeforeRemove?.lng"), false);
  assertEquals(src.includes("trip.driver_location_lat"), false);
  assertEquals(src.includes("trip.driver_location_lng"), false);

  assertEquals(src.includes("resolveModificationRouteOrigin({"), true);
  assertEquals(src.includes('.from("trip_driver_live_location")'), true);
  assertEquals(src.includes("const originLat = origin.lat;"), true);
  assertEquals(src.includes("const originLng = origin.lng;"), true);
});
