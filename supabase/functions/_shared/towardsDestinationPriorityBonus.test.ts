/**
 * Unit tests for towards-destination soft priority bonus.
 * Run: deno test --allow-env supabase/functions/_shared/towardsDestinationPriorityBonus.test.ts
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeDispatchScore,
  towardsDestinationPriorityBonus,
} from "./dispatch-settings.ts";

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const settings = {
  towards_destination_enabled: true,
  towards_destination_matching_tolerance_meters: 3000,
  towards_destination_priority_weight: 12,
  distance_penalty_per_km: 2,
  waiting_bonus_per_minute: 0,
  max_waiting_bonus_minutes: 20,
  fairness_idle_minutes: 999,
  fairness_boost_score: 10,
};

Deno.test("compatible dropoff receives bounded bonus", () => {
  const bonus = towardsDestinationPriorityBonus(
    settings,
    52.04,
    -0.76,
    { lat: 52.041, lng: -0.761, active: true, expires_at: null },
    haversine,
  );
  assertEquals(bonus, 12);
});

Deno.test("incompatible dropoff remains eligible (bonus 0)", () => {
  const bonus = towardsDestinationPriorityBonus(
    settings,
    52.04,
    -0.76,
    { lat: 53.5, lng: -1.5, active: true, expires_at: null },
    haversine,
  );
  assertEquals(bonus, 0);
});

Deno.test("inactive preference has no effect", () => {
  const bonus = towardsDestinationPriorityBonus(
    settings,
    52.04,
    -0.76,
    { lat: 52.041, lng: -0.761, active: false, expires_at: null },
    haversine,
  );
  assertEquals(bonus, 0);
});

Deno.test("expired preference has no effect", () => {
  const bonus = towardsDestinationPriorityBonus(
    settings,
    52.04,
    -0.76,
    {
      lat: 52.041,
      lng: -0.761,
      active: true,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    },
    haversine,
  );
  assertEquals(bonus, 0);
});

Deno.test("disabled feature yields zero bonus", () => {
  const bonus = towardsDestinationPriorityBonus(
    { ...settings, towards_destination_enabled: false },
    52.04,
    -0.76,
    { lat: 52.041, lng: -0.761, active: true, expires_at: null },
    haversine,
  );
  assertEquals(bonus, 0);
});

Deno.test("score ranks compatible driver above equal peer", () => {
  const base = { category_priority: 10 };
  const a = computeDispatchScore(settings, { ...base, towards_bonus: 12 }, 1000);
  const b = computeDispatchScore(settings, { ...base, towards_bonus: 0 }, 1000);
  assertEquals(a > b, true);
});
