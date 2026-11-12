/**
 * Phase 4 directional ranking preference tests.
 * Run: deno test --no-check --allow-read supabase/functions/_shared/scheduledDirectionalDispatchSSOT.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  compareWithDirectionalBoost,
  computeScheduledDirectionalScoreBoost,
} from "./scheduledDirectionalDispatchSSOT.ts";

const SCHEDULED = { lat: 52.04, lng: -0.76, scheduledAtMs: Date.parse("2026-11-12T20:30:00.000Z") };
const DRIVER_FROM = { lat: 52.00, lng: -0.76 };

Deno.test("directional: dropoff nearer scheduled pickup gets positive boost", () => {
  // Dropoff between driver and scheduled pickup → reduces empty travel.
  const nearer = computeScheduledDirectionalScoreBoost({
    dropoffLat: 52.02,
    dropoffLng: -0.76,
    fromLat: DRIVER_FROM.lat,
    fromLng: DRIVER_FROM.lng,
    scheduledPickup: SCHEDULED,
  });
  assert(nearer.nearer);
  assert(nearer.scoreBoost > 0);
  assert(nearer.emptyTravelSavedMeters > 0);

  const farther = computeScheduledDirectionalScoreBoost({
    dropoffLat: 51.90,
    dropoffLng: -0.76,
    fromLat: DRIVER_FROM.lat,
    fromLng: DRIVER_FROM.lng,
    scheduledPickup: SCHEDULED,
  });
  // Other direction: boost may be 0 (or near-area only) — never negative / hard exclude.
  assert(farther.scoreBoost >= 0);
  assertEquals(farther.nearer, false);
  assert(nearer.scoreBoost > farther.scoreBoost);
});

Deno.test("directional: near scheduled pickup area adds soft bonus", () => {
  const near = computeScheduledDirectionalScoreBoost({
    dropoffLat: 52.041,
    dropoffLng: -0.761,
    fromLat: DRIVER_FROM.lat,
    fromLng: DRIVER_FROM.lng,
    scheduledPickup: SCHEDULED,
    nearPickupRadiusMeters: 3000,
  });
  assertEquals(near.nearPickupArea, true);
  assert(near.scoreBoost >= 8);
});

Deno.test("no scheduled commitment → boost 0 (normal dispatch ranking)", () => {
  const none = computeScheduledDirectionalScoreBoost({
    dropoffLat: 52.02,
    dropoffLng: -0.76,
    fromLat: DRIVER_FROM.lat,
    fromLng: DRIVER_FROM.lng,
    scheduledPickup: null,
  });
  assertEquals(none.scoreBoost, 0);
  assertEquals(none.nearer, false);
});

Deno.test("compatible non-directional journeys remain eligible (ranking only)", () => {
  // Equal base scores: directional preferred first, but other direction still ranks (finite).
  const boostToward = computeScheduledDirectionalScoreBoost({
    dropoffLat: 52.03,
    dropoffLng: -0.76,
    fromLat: DRIVER_FROM.lat,
    fromLng: DRIVER_FROM.lng,
    scheduledPickup: SCHEDULED,
  }).scoreBoost;
  const boostAway = computeScheduledDirectionalScoreBoost({
    dropoffLat: 51.95,
    dropoffLng: -0.76,
    fromLat: DRIVER_FROM.lat,
    fromLng: DRIVER_FROM.lng,
    scheduledPickup: SCHEDULED,
  }).scoreBoost;
  assert(boostAway >= 0);
  const order = compareWithDirectionalBoost({
    scoreA: 50,
    scoreB: 50,
    boostA: boostAway,
    boostB: boostToward,
    distanceA: 2000,
    distanceB: 2100,
  });
  // B (toward) wins preference; A remains a valid candidate (comparator only).
  assert(order > 0);
});

Deno.test("source lock: auto-dispatch uses directional SSOT without parallel engine", async () => {
  const auto = await Deno.readTextFile(
    new URL("../auto-dispatch/index.ts", import.meta.url),
  );
  assert(auto.includes("scheduledDirectionalDispatchSSOT"));
  assert(auto.includes("compareWithDirectionalBoost"));
  assert(auto.includes("computeScheduledDirectionalScoreBoost"));
  assert(auto.includes("Ranking only"));
});
