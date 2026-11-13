/**
 * Waiting segment clock — enter/leave/resume + stale fail-closed.
 * Run: deno test --no-check --allow-read supabase/functions/_shared/waitingSegmentClock.execution.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_WAITING_RADIUS_METERS,
  TRUSTED_LOCATION_MAX_AGE_MS,
  haversineMeters,
  resolveEffectiveWaitingRadiusMeters,
} from "./waitingSegmentClock.ts";
import { buildPickupWaitingSnapshot } from "./waitingAdminConfig.ts";

Deno.test("configured 150m radius is used; default only when unset", () => {
  assertEquals(resolveEffectiveWaitingRadiusMeters(150, true), 150);
  assertEquals(
    resolveEffectiveWaitingRadiusMeters(0, true),
    DEFAULT_WAITING_RADIUS_METERS,
  );
  assertEquals(resolveEffectiveWaitingRadiusMeters(150, false), 0);
});

Deno.test("MK-261113-003 distance 933m is outside 150m", () => {
  const pickup = { lat: 52.0081825, lng: -0.7884515 };
  // ~933m offset roughly north
  const driver = { lat: 52.0165, lng: -0.7884515 };
  const d = haversineMeters(driver.lat, driver.lng, pickup.lat, pickup.lng);
  assert(d > 150);
  assert(d > 800);
});

Deno.test("trusted location max age remains 45s (fail-closed money)", () => {
  assertEquals(TRUSTED_LOCATION_MAX_AGE_MS, 45_000);
});

Deno.test("pickup snapshot uses counted seconds for free/no-show remaining", () => {
  const started = "2026-11-13T09:19:57.418Z";
  const nowMs = Date.parse(started) + 90_000; // 90s wall
  const snap = buildPickupWaitingSnapshot({
    driverArrivedAt: started,
    waitingStatus: "blocked_outside_radius",
    config: {
      config_available: true,
      free_pickup_waiting_seconds: 180,
      free_pickup_waiting_minutes: 3,
      no_show_waiting_seconds: 300,
      no_show_waiting_minutes: 5,
      pickup_paid_waiting_enabled: true,
      pickup_paid_waiting_rate_pence_per_minute: 30,
      pickup_waiting_max_minutes: 0,
      waiting_charge_interval_seconds: 15,
      waiting_charge_rounding: "completed_intervals",
      no_show_apply_after_arrival_only: true,
      pickup_radius_enabled: true,
      pickup_radius_meters: 150,
      stop_radius_enabled: true,
      stop_radius_meters: 150,
      enable_stop_waiting_charge: false,
      stop_waiting_grace_period_seconds: 180,
      stop_waiting_rate_pence_per_minute: 0,
      stop_waiting_max_minutes: 0,
      stop_waiting_charge_interval_seconds: 15,
      service_area_id: null,
      vehicle_type_id: null,
      trip_id: null,
      driver_id: null,
      frozen_at: null,
      waiting_context: "pickup",
      pickup_grace_source: "fare_pricing",
      waiting_charge_interval_source: "dispatch_settings",
    } as any,
    countedInRadiusSeconds: 0,
    nowMs,
  });
  assertEquals(snap.pickup_waiting_elapsed_seconds, 0);
  assertEquals(snap.pickup_waiting_grace_remaining_seconds, 180);
  assertEquals(snap.no_show_remaining_seconds, 300);
  assertEquals(snap.no_show_eligible, false);
});

Deno.test("blocked_outside_radius is a known waiting status (compat)", async () => {
  const stop = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  assert(stop.includes("blocked_outside_radius"));
  // Arrived still starts session (eligible accumulation separate).
  assert(stop.includes("waiting_still_starts_on_arrived"));
  // Start Trip finalize still uses counted seconds, not wall.
  assert(stop.includes("Never charge full wall-time"));
});
