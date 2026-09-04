/**
 * Waiting geofence segment clock — acceptance cases A–K.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  chargeableSecondsFromCounted,
  computePickupChargeFromCountedSeconds,
  computeStopChargeFromCountedSeconds,
  DEFAULT_WAITING_RADIUS_METERS,
  evaluateWaitingInsideRadius,
  haversineMeters,
  noShowEligibleFromCountedSeconds,
  resolveEffectiveWaitingRadiusMeters,
  segmentDurationSeconds,
  sumSegmentSeconds,
  type TrustedDriverLocation,
} from "./waitingSegmentClock.ts";
import { evaluateCanMarkNoShow } from "./tripNoShowRules.ts";

const PICKUP = { lat: 52.04, lng: -0.76 };
const FAR = { lat: 52.05, lng: -0.75 }; // ~1.4km
const NEAR = { lat: 52.0401, lng: -0.7601 }; // ~13m

function trustedAt(
  lat: number,
  lng: number,
  source: TrustedDriverLocation["source"] = "driver_presence",
): TrustedDriverLocation {
  return {
    lat,
    lng,
    sampledAtIso: new Date().toISOString(),
    source,
    ageMs: 1000,
  };
}

Deno.test("A: arrive far → counted starts at 0 (outside, no open chargeable clock)", () => {
  const v = evaluateWaitingInsideRadius({
    trusted: trustedAt(FAR.lat, FAR.lng),
    bodyLat: FAR.lat,
    bodyLng: FAR.lng,
    target: {
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      radiusMeters: 100,
      radiusEnabled: true,
    },
  });
  assertEquals(v.inside, false);
  assertEquals(v.distanceMeters! > 100, true);
  // No segment open → counted 0
  assertEquals(sumSegmentSeconds([], Date.now()), 0);
});

Deno.test("B: outside whole time → waiting charge 0", () => {
  const counted = 0;
  const pickup = computePickupChargeFromCountedSeconds({
    countedSeconds: counted,
    freeWaitSeconds: 180,
    ratePencePerMinute: 20,
    intervalSeconds: 60,
    maxMinutes: 30,
  });
  const stop = computeStopChargeFromCountedSeconds({
    countedSeconds: counted,
    freeWaitSeconds: 60,
    ratePencePerMinute: 20,
    maxMinutes: 30,
  });
  assertEquals(pickup.charge_pence, 0);
  assertEquals(stop.charge_pence, 0);
});

Deno.test("C: in/out/in segment math (pause closes, resume opens)", () => {
  const t0 = Date.parse("2026-09-04T12:00:00.000Z");
  const segs = [
    {
      started_at: new Date(t0).toISOString(),
      ended_at: new Date(t0 + 120_000).toISOString(),
    },
    // gap outside 60s
    {
      started_at: new Date(t0 + 180_000).toISOString(),
      ended_at: new Date(t0 + 300_000).toISOString(),
    },
  ];
  const counted = sumSegmentSeconds(segs, t0 + 300_000);
  assertEquals(counted, 240); // 120 + 120
  assertEquals(
    chargeableSecondsFromCounted(counted, 180),
    60,
  );
});

Deno.test("D: Start Trip far OK + charge from counted only (not wall)", () => {
  // Wall = 600s outside; counted = 90s inside → free 180 → charge 0
  const wallWouldCharge = computePickupChargeFromCountedSeconds({
    countedSeconds: 600,
    freeWaitSeconds: 180,
    ratePencePerMinute: 40,
    intervalSeconds: 60,
    maxMinutes: 30,
  });
  const countedOnly = computePickupChargeFromCountedSeconds({
    countedSeconds: 90,
    freeWaitSeconds: 180,
    ratePencePerMinute: 40,
    intervalSeconds: 60,
    maxMinutes: 30,
  });
  assertEquals(wallWouldCharge.charge_pence > 0, true);
  assertEquals(countedOnly.charge_pence, 0);

  // Counted 300s with free 180 → paid 120 → 2 intervals @ 40ppm / 60s
  const charged = computePickupChargeFromCountedSeconds({
    countedSeconds: 300,
    freeWaitSeconds: 180,
    ratePencePerMinute: 40,
    intervalSeconds: 60,
    maxMinutes: 30,
  });
  assertEquals(charged.intervals_charged, 2);
  assertEquals(charged.charge_pence, 80);
});

Deno.test("E: no-show needs counted in-radius time, not Arrived wall-time", () => {
  const arrivedLongAgo = new Date(Date.now() - 20 * 60_000).toISOString();
  const pricing = {
    noShowWaitMinutes: 5,
    freeWaitingMinutes: 5,
    noShowFeePence: 500,
    noShowAfterArrivalOnly: true,
  };
  const dispatch = {
    pickupRadiusEnabled: true,
    pickupRadiusMeters: 100,
  };

  const wallOnly = evaluateCanMarkNoShow({
    tripStatus: "arrived",
    arrivedAtIso: arrivedLongAgo,
    pricing,
    dispatch,
    countedInRadiusSeconds: 30, // only 30s in radius
    driverLat: NEAR.lat,
    driverLng: NEAR.lng,
    pickupLat: PICKUP.lat,
    pickupLng: PICKUP.lng,
  });
  assertEquals(wallOnly.canMark, false);

  const countedOk = evaluateCanMarkNoShow({
    tripStatus: "arrived",
    arrivedAtIso: arrivedLongAgo,
    pricing,
    dispatch,
    countedInRadiusSeconds: 5 * 60,
    driverLat: NEAR.lat,
    driverLng: NEAR.lng,
    pickupLat: PICKUP.lat,
    pickupLng: PICKUP.lng,
  });
  assertEquals(countedOk.canMark, true);
  assertEquals(noShowEligibleFromCountedSeconds({ countedSeconds: 30, requiredWaitMinutes: 5 }), false);
});

Deno.test("F: spoofed body GPS ignored when trusted says outside", () => {
  const v = evaluateWaitingInsideRadius({
    trusted: trustedAt(FAR.lat, FAR.lng),
    bodyLat: PICKUP.lat, // spoof at pickup
    bodyLng: PICKUP.lng,
    target: {
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      radiusMeters: 100,
      radiusEnabled: true,
    },
  });
  assertEquals(v.inside, false);
  assertEquals(v.trustedOverridesBody, true);
  assertEquals(v.usedSource, "driver_presence");
});

Deno.test("G: multi-stop segments are stop-scoped (separate sums)", () => {
  const now = Date.parse("2026-09-04T13:00:00.000Z");
  const stop1 = [
    {
      started_at: new Date(now - 90_000).toISOString(),
      ended_at: new Date(now - 30_000).toISOString(),
    },
  ];
  const stop2 = [
    {
      started_at: new Date(now - 40_000).toISOString(),
      ended_at: null,
    },
  ];
  assertEquals(sumSegmentSeconds(stop1, now), 60);
  assertEquals(sumSegmentSeconds(stop2, now), 40);
  // Independent clocks — not summed across stops for a single finalize
  assertEquals(sumSegmentSeconds(stop1, now) !== sumSegmentSeconds(stop2, now), true);
});

Deno.test("H: fare structure fed only by counted valid waiting", () => {
  const pickup = computePickupChargeFromCountedSeconds({
    countedSeconds: 240,
    freeWaitSeconds: 60,
    ratePencePerMinute: 30,
    intervalSeconds: 60,
    maxMinutes: 10,
  });
  const stop = computeStopChargeFromCountedSeconds({
    countedSeconds: 120,
    freeWaitSeconds: 60,
    ratePencePerMinute: 20,
    maxMinutes: null,
  });
  // pickup: paid 180s → 3 intervals × 30 = 90
  assertEquals(pickup.charge_pence, 90);
  // stop: paid 60s continuous → 20
  assertEquals(stop.charge_pence, 20);
  const total = pickup.charge_pence + stop.charge_pence;
  assertEquals(total, 110);
});

Deno.test("I: default radius 100m when enabled and meters missing", () => {
  assertEquals(resolveEffectiveWaitingRadiusMeters(null, true), DEFAULT_WAITING_RADIUS_METERS);
  assertEquals(resolveEffectiveWaitingRadiusMeters(0, true), 100);
  assertEquals(resolveEffectiveWaitingRadiusMeters(150, true), 150);
  assertEquals(resolveEffectiveWaitingRadiusMeters(0, false), 0);
});

Deno.test("J: no trusted location → fail closed (outside / no charge)", () => {
  const v = evaluateWaitingInsideRadius({
    trusted: null,
    bodyLat: PICKUP.lat,
    bodyLng: PICKUP.lng,
    target: {
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      radiusMeters: 100,
      radiusEnabled: true,
    },
  });
  assertEquals(v.inside, false);
  assertEquals(v.usedSource, "no_trusted_location");
});

Deno.test("K: workflow radius-disabled still counts (inside=true); near point distance sanity", () => {
  const disabled = evaluateWaitingInsideRadius({
    trusted: trustedAt(FAR.lat, FAR.lng),
    target: {
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      radiusMeters: 100,
      radiusEnabled: false,
    },
  });
  assertEquals(disabled.inside, true);
  assertEquals(disabled.usedSource, "radius_disabled");

  const d = haversineMeters(NEAR.lat, NEAR.lng, PICKUP.lat, PICKUP.lng);
  assertEquals(d < 100, true);
  assertEquals(segmentDurationSeconds(
    "2026-09-04T12:00:00.000Z",
    "2026-09-04T12:01:00.000Z",
    Date.parse("2026-09-04T12:01:00.000Z"),
  ), 60);
});

/** Lock: Start Trip must not use wall-time from pickup_waiting_started_at. */
Deno.test("lock: stop-workflow finalize uses counted segments not wall elapsed", async () => {
  const src = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  assertEquals(src.includes("charge_from_counted_segments_not_wall_time"), true);
  assertEquals(src.includes("computePickupChargeFromCountedSeconds"), true);
  assertEquals(src.includes("closeOpenWaitingSegments"), true);
  // Old wall-time finalize pattern must not remain as the charge path
  assertEquals(
    /elapsedSeconds\s*=\s*Math\.max\(\s*0,\s*Math\.floor\(\(new Date\(nowIso\)\.getTime\(\)\s*-\s*new Date\(startedAt\)\.getTime\(\)\)/.test(
      src,
    ),
    false,
  );
});

Deno.test("lock: tick-pickup uses syncWaitingGeofenceClock + counted seconds", async () => {
  const src = await Deno.readTextFile(
    new URL("../tick-pickup-waiting-charge/index.ts", import.meta.url),
  );
  assertEquals(src.includes("syncWaitingGeofenceClock"), true);
  assertEquals(src.includes("counted_in_radius_seconds"), true);
  assertEquals(src.includes("computePickupChargeFromCountedSeconds"), true);
});

Deno.test("lock: pickup-no-show uses countedInRadiusSeconds", async () => {
  const src = await Deno.readTextFile(
    new URL("../pickup-no-show/index.ts", import.meta.url),
  );
  assertEquals(src.includes("countedInRadiusSeconds"), true);
  assertEquals(src.includes("resolveTrustedDriverLocation"), true);
});

Deno.test("lock: hydrate surfaces geofence + counted waiting fields", async () => {
  const restore = await Deno.readTextFile(
    new URL("./activeTripRestoreCore.ts", import.meta.url),
  );
  assertEquals(restore.includes("waiting_geofence_status"), true);
  assertEquals(restore.includes("pickup_waiting_counted_seconds"), true);
  assertEquals(restore.includes("stop_waiting_counted_seconds"), true);
  assertEquals(restore.includes("countedInRadiusSeconds"), true);

  const getActive = await Deno.readTextFile(
    new URL("../get-active-trip/index.ts", import.meta.url),
  );
  assertEquals(getActive.includes("waiting_geofence_status"), true);
  assertEquals(getActive.includes("pickup_waiting_counted_seconds"), true);
  assertEquals(getActive.includes("stop_waiting_counted_seconds"), true);
});

Deno.test("lock: buildPickupWaitingSnapshot no-show uses counted when provided", async () => {
  const { buildPickupWaitingSnapshot, buildAdminWaitingConfigSnapshot } = await import(
    "./waitingAdminConfig.ts"
  );
  const config = buildAdminWaitingConfigSnapshot(
    {
      free_waiting_minutes: 3,
      no_show_wait_time_minutes: 4,
      pickup_paid_waiting_enabled: true,
      waiting_per_minute_pence: 24,
    },
    {
      pickup_waiting_grace_period_seconds: 180,
      pickup_paid_waiting_enabled: true,
      pickup_paid_waiting_rate_pence_per_minute: 24,
      stop_waiting_charge_interval_seconds: 15,
    },
    null,
  );
  const arrived = "2026-09-04T10:00:00.000Z";
  // Wall would be 30 min; counted only 30s → not eligible.
  const snap = buildPickupWaitingSnapshot({
    driverArrivedAt: arrived,
    waitingStatus: "free_waiting",
    config,
    nowMs: Date.parse("2026-09-04T10:30:00.000Z"),
    countedInRadiusSeconds: 30,
  });
  assertEquals(snap.no_show_eligible, false);
  assertEquals(snap.no_show_remaining_seconds, Math.max(0, config.no_show_waiting_seconds - 30));
  assertEquals(snap.pickup_waiting_elapsed_seconds, 30);
  assertEquals(snap.no_show_eligible_at, null);

  const eligible = buildPickupWaitingSnapshot({
    driverArrivedAt: arrived,
    waitingStatus: "free_waiting",
    config,
    nowMs: Date.parse("2026-09-04T10:30:00.000Z"),
    countedInRadiusSeconds: config.no_show_waiting_seconds,
  });
  assertEquals(eligible.no_show_eligible, true);
  assertEquals(eligible.no_show_remaining_seconds, 0);
});
