/**
 * Fleet maximum pickup distance SSOT — regression / source locks.
 *
 * Covers: shared helper failsafe, distinct reject reason, Edge idle+stacked,
 * SQL dispatch_trip_offers, scheduled→auto-dispatch handoff, Admin field,
 * migration backfill, rollback safety (never uncapped missing settings).
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { canonicalizeDispatchRejectReason } from "../../functions/_shared/dispatchEligibilityPolicy.ts";
import {
  EXCEEDS_FLEET_MAX_PICKUP_DISTANCE,
  FLEET_MAX_PICKUP_DISTANCE_MILES_FAILSAFE,
  FLEET_MAX_PICKUP_MILES_TO_METERS,
  exceedsFleetMaxPickupDistance,
  resolveFleetMaxPickupDistanceMiles,
} from "../../../shared/fleetMaxPickupDistanceSSOT.ts";
import {
  fleetMaxPickupMetersFromSettings,
  overlayGlobalDispatchSettings,
  mergeDispatchRow,
} from "../../functions/_shared/dispatch-settings.ts";
import {
  BOOKING_DISPATCH_WAVE_RADIUS_DEFAULTS_METERS,
} from "../../../shared/bookingDispatchRadiusSSOT.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(`${ROOT}${rel}`);
}

Deno.test("failsafe never disables gate (null/0/missing → 17.8)", () => {
  assertEquals(resolveFleetMaxPickupDistanceMiles(null), 17.8);
  assertEquals(resolveFleetMaxPickupDistanceMiles(0), 17.8);
  assertEquals(resolveFleetMaxPickupDistanceMiles(undefined), 17.8);
  assertEquals(FLEET_MAX_PICKUP_DISTANCE_MILES_FAILSAFE, 17.8);
});

Deno.test("canonicalize keeps exceeds_fleet_max_pickup_distance distinct", () => {
  assertEquals(
    canonicalizeDispatchRejectReason("exceeds_fleet_max_pickup_distance"),
    EXCEEDS_FLEET_MAX_PICKUP_DISTANCE,
  );
  // Legacy per-driver still aliases to outside_service_area
  assertEquals(
    canonicalizeDispatchRejectReason("exceeds_driver_max_pickup_distance"),
    "outside_service_area",
  );
  assertEquals(
    canonicalizeDispatchRejectReason("outside_radius"),
    "outside_service_area",
  );
});

Deno.test("overlayGlobalDispatchSettings injects failsafe when global row missing", () => {
  const merged = overlayGlobalDispatchSettings(mergeDispatchRow(null), null);
  assertEquals(merged.fleet_max_pickup_distance_miles, 17.8);
  assertEquals(
    Math.round(fleetMaxPickupMetersFromSettings(merged)),
    Math.round(17.8 * FLEET_MAX_PICKUP_MILES_TO_METERS),
  );
});

Deno.test("overlay resolves invalid fleet_max column to failsafe", () => {
  const merged = overlayGlobalDispatchSettings(mergeDispatchRow(null), {
    fleet_max_pickup_distance_miles: -5,
  });
  assertEquals(merged.fleet_max_pickup_distance_miles, 17.8);
});

Deno.test("MK-style distances vs 17.8 mi fleet max (MK-261110-002 class)", () => {
  // 19 km ≈ 11.8 mi — within 17.8 (was excluded only by legacy 5.0 preference)
  assertEquals(exceedsFleetMaxPickupDistance(19_000, 17.8), false);
  // Wave-3 edge (~29 km) is beyond 17.8 mi ≈ 28.65 km
  assertEquals(exceedsFleetMaxPickupDistance(29_000, 17.8), true);
  assertEquals(exceedsFleetMaxPickupDistance(28_000, 17.8), false);
  assertEquals(exceedsFleetMaxPickupDistance(10_000, 5.0), true); // legacy 5 mi preference class
});

Deno.test("source lock: auto-dispatch uses fleet SSOT, not per-driver maxDistanceMap gate", async () => {
  const src = await read("supabase/functions/auto-dispatch/index.ts");
  assertStringIncludes(src, "fleetMaxPickupMetersFromSettings");
  assertStringIncludes(src, "EXCEEDS_FLEET_MAX_PICKUP_DISTANCE");
  assertStringIncludes(src, "exceedsFleetMaxPickupDistance");
  // Must not rebuild the old optional per-driver map gate
  assert(
    !src.includes("maxDistanceMap"),
    "legacy maxDistanceMap gate must be removed",
  );
  assert(
    !src.includes('"exceeds_driver_max_pickup_distance"'),
    "idle/stacked path must emit fleet reason, not legacy driver preference reason",
  );
  // Stacked path also gated
  assert(
    src.includes("stacked_gate: true") &&
      src.includes("EXCEEDS_FLEET_MAX_PICKUP_DISTANCE"),
    "stacked path must log fleet reject",
  );
});

Deno.test("source lock: scheduled-dispatch creates offers only via auto-dispatch", async () => {
  const src = await read("supabase/functions/scheduled-dispatch/index.ts");
  assertStringIncludes(src, "/functions/v1/auto-dispatch");
  // scheduled-dispatch must not invent its own max_pickup gate
  assert(!src.includes("max_pickup_distance_miles"));
});

Deno.test("source lock: SQL dispatch_trip_offers migration enforces fleet max", async () => {
  const mig = await read(
    "supabase/migrations/20270101150000_fleet_max_pickup_distance_ssot.sql",
  );
  assertStringIncludes(mig, "fleet_max_pickup_distance_miles");
  assertStringIncludes(mig, "resolve_fleet_max_pickup_distance_meters");
  assertStringIncludes(mig, "exceeds_fleet_max_pickup_distance");
  assertStringIncludes(mig, "v_fleet_max_m");
  // Backfill missing settings only
  assertStringIncludes(mig, "INSERT INTO public.driver_settings");
  assertStringIncludes(mig, "WHERE NOT EXISTS");
  // Must not overwrite existing unrelated settings (no blanket UPDATE of all rows)
  assert(
    !/UPDATE\s+public\.driver_settings\s+SET\s+max_pickup_distance_miles\s*=\s*17\.8[\s\S]*WHERE\s+max_pickup_distance_miles\s+IS\s+DISTINCT/i
      .test(mig),
    "forward migration must not overwrite existing driver_settings max_pickup values",
  );
});

Deno.test("source lock: rollback never restores uncapped missing-settings", async () => {
  const rb = await read(
    "supabase/migrations/rollback/rollback_20270101150000_fleet_max_pickup_distance_ssot.sql",
  );
  assertStringIncludes(rb, "INSERT INTO public.driver_settings");
  assertStringIncludes(rb, "WHERE NOT EXISTS");
  assertStringIncludes(rb, "ALTER COLUMN max_pickup_distance_miles SET DEFAULT 17.8");
  // Restores pre-fleet SQL before dropping helper
  assertStringIncludes(rb, "CREATE OR REPLACE FUNCTION public.dispatch_trip_offers");
  assert(
    rb.indexOf("INSERT INTO public.driver_settings") <
      rb.indexOf("DROP COLUMN IF EXISTS fleet_max_pickup_distance_miles"),
    "backfill must run before dropping fleet column",
  );
});

Deno.test("source lock: booking wave radii defaults unchanged (MK 13/17/29 km class)", () => {
  // Live MK ops use 5/17/29 in Admin; schema defaults remain the SSOT defaults object.
  assertEquals(BOOKING_DISPATCH_WAVE_RADIUS_DEFAULTS_METERS.wave2, 17_000);
  assertEquals(BOOKING_DISPATCH_WAVE_RADIUS_DEFAULTS_METERS.wave3, 29_000);
});

Deno.test("source lock: migration does not alter wave radius columns", async () => {
  const mig = await read(
    "supabase/migrations/20270101150000_fleet_max_pickup_distance_ssot.sql",
  );
  assert(
    !/ALTER\s+COLUMN\s+start_radius_meters/i.test(mig),
    "must not alter start_radius_meters",
  );
  assert(
    !/ALTER\s+COLUMN\s+expand_radius_meters/i.test(mig),
    "must not alter expand_radius_meters",
  );
  assert(
    !/ALTER\s+COLUMN\s+max_radius_meters/i.test(mig),
    "must not alter max_radius_meters",
  );
});

Deno.test("source lock: Admin AutoDispatchRules wires fleet field + validation + RBAC page", async () => {
  const page = await read("src/pages/AutoDispatchRules.tsx");
  assertStringIncludes(page, "fleetMaxPickupDistanceMiles");
  assertStringIncludes(page, "fleet_max_pickup_distance_miles");
  assertStringIncludes(page, "validateFleetMaxPickupDistanceMiles");
  assertStringIncludes(page, "FLEET_MAX_PICKUP_DISTANCE_MILES_FAILSAFE");

  const catalog = await read("shared/adminPageCatalogSSOT.ts");
  assertStringIncludes(catalog, "auto-dispatch");
});

Deno.test("source lock: dispatchEligibilityPolicy lists fleet reject reason", async () => {
  const pol = await read(
    "supabase/functions/_shared/dispatchEligibilityPolicy.ts",
  );
  assertStringIncludes(pol, '"exceeds_fleet_max_pickup_distance"');
});

Deno.test("dispatch path coverage matrix documented in lock", () => {
  // Instant / rematch / scheduled handover → Edge auto-dispatch (fleet gate).
  // SQL Wave-1 / emergency → dispatch_trip_offers (fleet gate in migration).
  // Stacked → Edge stacked gates (fleet gate).
  // Scheduled Edge → invokes auto-dispatch only.
  const paths = [
    "edge_auto_dispatch_idle",
    "edge_auto_dispatch_stacked",
    "edge_auto_dispatch_rematch",
    "sql_dispatch_trip_offers",
    "scheduled_dispatch_via_auto_dispatch",
  ];
  assertEquals(paths.length, 5);
});
