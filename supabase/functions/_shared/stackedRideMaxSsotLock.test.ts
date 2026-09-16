/**
 * Lock: Admin Max Stacked Rides (1–3) is SSOT via global_dispatch_settings.
 * No hidden Edge cap below Admin max=3.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  STACKED_RIDES_ADMIN_MAX,
  effectiveMaxStackedRides,
  evaluateStackedDriverEligibility,
  resolveStackedRideConfig,
} from "./stackedRideConfig.ts";

Deno.test("effectiveMaxStackedRides honors Admin 1–3 (no hidden cap at 2)", () => {
  assertEquals(STACKED_RIDES_ADMIN_MAX, 3);
  assertEquals(effectiveMaxStackedRides(1), 1);
  assertEquals(effectiveMaxStackedRides(2), 2);
  assertEquals(effectiveMaxStackedRides(3), 3);
  assertEquals(effectiveMaxStackedRides(4), 3);
  assertEquals(effectiveMaxStackedRides(0), 1);
});

Deno.test("resolveStackedRideConfig maxStackedRides follows Admin value up to 3", () => {
  const cfg = resolveStackedRideConfig({
    stacked_rides_enabled: true,
    max_stacked_rides: 3,
    stacked_search_radius_meters: 7000,
    stacked_min_trip_distance_meters: 1000,
    stacked_max_detour_minutes: 20,
    stacked_offer_window_minutes: 15,
    allow_airport_stacking: true,
    allow_scheduled_stacking: true,
    allow_stacking_during_pickup_waiting: true,
    allow_stacking_during_stop_waiting: true,
  });
  assertEquals(cfg.operational, true);
  assertEquals(cfg.maxStackedRides, 3);
});

Deno.test("eligibility allows second queued when Admin max is 3", () => {
  const config = resolveStackedRideConfig({
    stacked_rides_enabled: true,
    max_stacked_rides: 3,
    stacked_search_radius_meters: 7000,
    stacked_min_trip_distance_meters: 1000,
    stacked_max_detour_minutes: 20,
    stacked_offer_window_minutes: 30,
    allow_airport_stacking: true,
    allow_scheduled_stacking: true,
    allow_stacking_during_pickup_waiting: true,
    allow_stacking_during_stop_waiting: true,
  });

  const baseTrip = {
    id: "trip-a",
    status: "in_progress",
    stacked_trip_id: "trip-b-already-queued",
    started_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    estimated_duration_minutes: 25,
  };

  const open = evaluateStackedDriverEligibility({
    config,
    newTrip: { estimated_distance_km: 5 },
    currentTrip: baseTrip,
    queuedCount: 1,
  });
  assertEquals(open.eligible, true);

  const full = evaluateStackedDriverEligibility({
    config,
    newTrip: { estimated_distance_km: 5 },
    currentTrip: baseTrip,
    queuedCount: 3,
  });
  assertEquals(full.eligible, false);
  if (!full.eligible) {
    assertEquals(full.reason, "stacked_queue_full");
  }
});
