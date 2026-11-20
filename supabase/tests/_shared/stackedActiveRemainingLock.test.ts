/**
 * #54B/C Lock: stacked remaining uses fresh last_eta or elapsed booked duration.
 * Never invents thresholds; preserves Admin offer window semantics.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateStackedDriverEligibility,
  resolveStackedActiveRemainingMinutes,
  resolveStackedRideConfig,
  STACKED_LAST_ETA_FRESH_MS,
} from "../../functions/_shared/stackedRideConfig.ts";

const config = resolveStackedRideConfig({
  stacked_rides_enabled: true,
  max_stacked_rides: 1,
  stacked_search_radius_meters: 7000,
  stacked_min_trip_distance_meters: 0,
  stacked_max_detour_minutes: 20,
  stacked_offer_window_minutes: 15,
  allow_airport_stacking: true,
  allow_scheduled_stacking: true,
  allow_stacking_during_pickup_waiting: true,
  allow_stacking_during_stop_waiting: true,
});

Deno.test("resolveStackedActiveRemainingMinutes prefers fresh last_eta", () => {
  const nowMs = Date.now();
  const r = resolveStackedActiveRemainingMinutes({
    status: "in_progress",
    started_at: new Date(nowMs - 60 * 60_000).toISOString(),
    estimated_duration_minutes: 90,
    last_eta_minutes: 8,
    last_eta_calculated_at: new Date(nowMs - 10_000).toISOString(),
    nowMs,
  });
  assertEquals(r.source, "last_eta");
  assertEquals(r.remainingMinutes != null && r.remainingMinutes <= 8, true);
});

Deno.test("resolveStackedActiveRemainingMinutes ignores stale last_eta (>90s)", () => {
  const nowMs = Date.now();
  const r = resolveStackedActiveRemainingMinutes({
    status: "in_progress",
    started_at: new Date(nowMs - 10 * 60_000).toISOString(),
    estimated_duration_minutes: 30,
    last_eta_minutes: 3,
    last_eta_calculated_at: new Date(
      nowMs - STACKED_LAST_ETA_FRESH_MS - 5_000,
    ).toISOString(),
    nowMs,
  });
  assertEquals(r.source, "elapsed_booked");
  // 30 booked - 10 elapsed ≈ 20
  assertEquals(
    r.remainingMinutes != null &&
      r.remainingMinutes >= 19 &&
      r.remainingMinutes <= 21,
    true,
  );
});

Deno.test("eligibility rejects when elapsed remaining exceeds offer window", () => {
  const nowMs = Date.now();
  const result = evaluateStackedDriverEligibility({
    config,
    newTrip: { estimated_distance_km: 5 },
    currentTrip: {
      id: "a",
      status: "in_progress",
      started_at: new Date(nowMs - 2 * 60_000).toISOString(),
      estimated_duration_minutes: 40,
    },
    queuedCount: 0,
    nowMs,
  });
  assertEquals(result.eligible, false);
  if (!result.eligible) {
    assertEquals(result.reason, "stacked_not_within_offer_window");
  }
});

Deno.test("eligibility allows when fresh last_eta is within offer window", () => {
  const nowMs = Date.now();
  const result = evaluateStackedDriverEligibility({
    config,
    newTrip: { estimated_distance_km: 5 },
    currentTrip: {
      id: "a",
      status: "in_progress",
      started_at: new Date(nowMs - 2 * 60_000).toISOString(),
      estimated_duration_minutes: 40,
      last_eta_minutes: 6,
      last_eta_calculated_at: new Date(nowMs - 5_000).toISOString(),
    },
    queuedCount: 0,
    nowMs,
  });
  assertEquals(result.eligible, true);
});

Deno.test("SQL helper migration and Edge share 90s freshness + radius preserved", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20270227140000_stacked_remaining_eta_and_orphan_link_cleanup.sql",
      import.meta.url,
    ),
  );
  assertEquals(sql.includes("resolve_stacked_active_remaining_minutes"), true);
  assertEquals(sql.includes("90 seconds"), true);
  assertEquals(sql.includes("last_eta_minutes"), true);
  assertEquals(sql.includes("stacked_trip_id = NULL"), true);
  // Must not re-apply fleet distance DDL
  assertEquals(sql.includes("ADD COLUMN IF NOT EXISTS fleet_max"), false);

  const accept = await Deno.readTextFile(
    new URL("../../functions/accept-offer/index.ts", import.meta.url),
  );
  assertEquals(accept.includes("resolveStackedActiveRemainingMinutes"), true);

  const auto = await Deno.readTextFile(
    new URL("../../functions/auto-dispatch/index.ts", import.meta.url),
  );
  assertEquals(auto.includes("last_eta_minutes, last_eta_calculated_at"), true);
});
