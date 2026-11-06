/**
 * Admin Distance Penalty must drive Edge auto-dispatch ranking.
 * global_dispatch_settings.distance_penalty_per_meter is SSOT — never let
 * schema-default distance_penalty_per_km=2 hide Admin values.
 *
 * Run:
 *   deno test --no-check --allow-read supabase/tests/_shared/dispatchDistancePenaltyAdminLiveLock.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeDispatchScore,
  DISPATCH_SETTINGS_SCHEMA_DEFAULTS,
  overlayGlobalDispatchSettings,
  resolveDistancePenaltyPerKm,
  type ResolvedDispatchSettings,
} from "../../functions/_shared/dispatch-settings.ts";

Deno.test("resolveDistancePenaltyPerKm prefers Admin per_meter over default per_km", () => {
  // Simulates mergeDispatchRow (schema defaults) + global overlay of Admin value.
  const settings = {
    ...DISPATCH_SETTINGS_SCHEMA_DEFAULTS,
    distance_penalty_per_km: 2.0,
    distance_penalty_per_meter: 0.005, // Admin UI 5.0 per km
  };
  assertEquals(resolveDistancePenaltyPerKm(settings), 5);
});

Deno.test("resolveDistancePenaltyPerKm falls back to per_km when per_meter absent", () => {
  assertEquals(
    resolveDistancePenaltyPerKm({ distance_penalty_per_km: 1.5 }),
    1.5,
  );
  assertEquals(resolveDistancePenaltyPerKm({}), 2);
});

Deno.test("overlayGlobalDispatchSettings aligns distance_penalty_per_km from Admin per_meter", () => {
  const merged = {
    ...DISPATCH_SETTINGS_SCHEMA_DEFAULTS,
    _source: "schema_defaults",
  } as ResolvedDispatchSettings;
  const overlaid = overlayGlobalDispatchSettings(merged, {
    distance_penalty_per_meter: 0.003,
    waiting_bonus_per_minute: 0.8,
    max_waiting_bonus_minutes: 15,
    fairness_idle_minutes: 10,
    fairness_boost_score: 12,
  });
  assertEquals(overlaid.distance_penalty_per_meter, 0.003);
  assertEquals(overlaid.distance_penalty_per_km, 3);
  assertEquals(resolveDistancePenaltyPerKm(overlaid), 3);
});

Deno.test("computeDispatchScore uses Admin distance penalty (closer driver ranks higher when penalty rises)", () => {
  const now = Date.parse("2026-11-06T12:00:00.000Z");
  const near = {
    category_priority: 0,
    last_trip_end_at: "2026-11-06T11:50:00.000Z",
  };
  const far = {
    category_priority: 0,
    last_trip_end_at: "2026-11-06T11:50:00.000Z",
  };

  const lowPenalty = {
    ...DISPATCH_SETTINGS_SCHEMA_DEFAULTS,
    distance_penalty_per_meter: 0.001, // 1 / km
  };
  const highPenalty = {
    ...DISPATCH_SETTINGS_SCHEMA_DEFAULTS,
    distance_penalty_per_meter: 0.01, // 10 / km
  };

  const nearLow = computeDispatchScore(lowPenalty, near, 1000, now); // 1 km
  const farLow = computeDispatchScore(lowPenalty, far, 5000, now); // 5 km
  const nearHigh = computeDispatchScore(highPenalty, near, 1000, now);
  const farHigh = computeDispatchScore(highPenalty, far, 5000, now);

  // Both prefer nearer; high penalty widens the gap.
  assertEquals(nearLow > farLow, true);
  assertEquals(nearHigh > farHigh, true);
  assertEquals(nearHigh - farHigh > nearLow - farLow, true);
});

Deno.test("source lock: resolver prefers per_meter before per_km", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/dispatch-settings.ts", import.meta.url),
  );
  const resolveIdx = src.indexOf("export function resolveDistancePenaltyPerKm");
  assert(resolveIdx > 0);
  const slice = src.slice(resolveIdx, resolveIdx + 900);
  const perMeterIdx = slice.indexOf("distance_penalty_per_meter");
  const perKmIdx = slice.indexOf("distance_penalty_per_km");
  assert(perMeterIdx > 0);
  assert(perKmIdx > 0);
  assertEquals(perMeterIdx < perKmIdx, true);
});

Deno.test("source lock: Admin save mirrors scoring weights into dispatch_settings", async () => {
  const page = await Deno.readTextFile(
    new URL("../../../src/pages/AutoDispatchRules.tsx", import.meta.url),
  );
  assert(page.includes("distance_penalty_per_km: savedSettings.distancePenaltyPerKm"));
  assert(page.includes("waiting_bonus_per_minute: savedSettings.waitingBonusPerMinute"));
  assert(page.includes("max_waiting_bonus_minutes: savedSettings.maxWaitingBonusMinutes"));
  assert(page.includes("fairness_idle_minutes: savedSettings.fairnessIdleMinutes"));
  assert(page.includes("fairness_boost_score: savedSettings.fairnessBoostScore"));
});
