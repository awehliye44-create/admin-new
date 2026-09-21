/**
 * Lock: intermediate-stop waiting geofence correctness (MK-260921-011 forensic).
 *
 * Root cause of missing stop segments on 011 was NOT a skipped insert bug:
 * waiting_geofence_distance_m ≈ 1419m → outside radius → money fail-closed
 * (no location_type='stop' segment). Waiting session on trip_stops still starts.
 *
 * Phase 3 did not remove stop geofence; syncWaitingGeofenceClock still runs.
 * Migration 20261122120000 is future-dated vs apply day 2026-09-21 — leave applied;
 * do not rename/reapply; new migrations must use chronological timestamps.
 *
 * Run: deno test --allow-read supabase/tests/_shared/stopWaitingGeofenceCorrectnessLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateWaitingInsideRadius,
  sumSegmentSeconds,
} from "../../functions/_shared/waitingSegmentClock.ts";

const stopWorkflowPath = new URL(
  "../../functions/stop-workflow/index.ts",
  import.meta.url,
);
const segmentPath = new URL(
  "../../functions/_shared/waitingSegmentClock.ts",
  import.meta.url,
);
const migrationPath = new URL(
  "../../migrations/20261122120000_start_pickup_waiting_on_arrive_rpc.sql",
  import.meta.url,
);

Deno.test("outside radius → no chargeable open (fail closed)", () => {
  const v = evaluateWaitingInsideRadius({
    trusted: {
      lat: 52.05,
      lng: -0.75,
      sampledAtIso: new Date().toISOString(),
      source: "driver_presence",
      ageMs: 1000,
    },
    bodyLat: 52.05,
    bodyLng: -0.75,
    target: {
      lat: 52.0369903,
      lng: -0.7702616,
      radiusMeters: 100,
      radiusEnabled: true,
    },
  });
  assertEquals(v.inside, false);
  assertEquals((v.distanceMeters ?? 0) > 1000, true);
  assertEquals(sumSegmentSeconds([], Date.now()), 0);
});

Deno.test("stop geofence path always calls syncWaitingGeofenceClock with stop_id", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  const fn = src.indexOf("async function tryStartStopWaiting");
  const block = src.slice(fn, fn + 9000);
  assertStringIncludes(block, "locationType: 'stop'");
  assertStringIncludes(block, "stopId: stop.id");
  assertStringIncludes(block, "syncWaitingGeofenceClock");
  assertStringIncludes(block, "segment_opened");
  assertStringIncludes(block, "money_fail_closed_no_chargeable_segment");
  assertStringIncludes(block, "stop_waiting_segment_created");
});

Deno.test("segment insert errors are logged (not silent)", async () => {
  const src = await Deno.readTextFile(segmentPath);
  assertStringIncludes(src, "SEGMENT_INSERT_FAILED");
  assertStringIncludes(src, "segmentOpened");
  assertStringIncludes(src, "skipReason");
  assertStringIncludes(src, "outside_radius");
  assertStringIncludes(src, "no_trusted_location");
});

Deno.test("arrive_stop responses include stops (7c3ad38a UI fix)", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  assertStringIncludes(src, "stops: arrivedStops");
  assertStringIncludes(src, "stops: idempotentStops");
  assertStringIncludes(src, "stops: advancedStops");
});

Deno.test("future-dated Phase3 migration documented — do not rename", async () => {
  const sql = await Deno.readTextFile(migrationPath);
  assertStringIncludes(sql, "start_pickup_waiting_on_arrive");
  // File timestamp is 20261122 (future vs 2026-09-21 apply). Leave applied.
  assertEquals(migrationPath.pathname.includes("20261122120000"), true);
});

Deno.test("pickup geofence remains location_type pickup with null stop_id in RPC", async () => {
  const sql = await Deno.readTextFile(migrationPath);
  assertStringIncludes(sql, "AND type = 'pickup'");
  const seg = await Deno.readTextFile(segmentPath);
  assertStringIncludes(seg, 'location_type: input.locationType');
  assertStringIncludes(seg, "stop_id: input.stopId ?? null");
});
