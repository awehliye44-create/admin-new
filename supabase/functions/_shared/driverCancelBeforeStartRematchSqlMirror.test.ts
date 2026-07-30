/**
 * Pure SQL-mirror allowlist / reject-set tests for driver_cancel_before_start_rematch.
 * Mirrors public.is_driver_cancel_rematch_eligible_status / rejected_status.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ELIGIBLE = new Set([
  "confirmed",
  "accepted",
  "driver_assigned",
  "en_route",
  "en_route_to_pickup",
  "driver_en_route",
  "enroute_to_pickup",
  "driver_arriving",
  "queued",
  "arrived",
  "arrived_pickup",
  "arrived_at_pickup",
  "at_pickup",
  "pickup_waiting",
  "waiting",
  "driver_arrived",
  "waiting_at_pickup",
]);

const REJECTED = new Set([
  "no_show",
  "no-show",
  "in_progress",
  "on_trip",
  "started",
  "ongoing",
  "completing",
  "passenger_onboard",
  "completed",
  "cancelled",
  "canceled",
  "customer_cancelled",
  "customer_canceled",
  "expired",
  "expired_no_driver",
  "declined",
  "failed",
  "searching_new_driver",
]);

function isEligible(status: string): boolean {
  return ELIGIBLE.has(status.trim().toLowerCase());
}

function isRejected(status: string): boolean {
  return REJECTED.has(status.trim().toLowerCase());
}

Deno.test("SQL mirror: rematch allowlist covers required aliases", () => {
  for (
    const s of [
      "confirmed",
      "accepted",
      "driver_assigned",
      "en_route",
      "en_route_to_pickup",
      "arrived",
      "arrived_at_pickup",
      "waiting_at_pickup",
      "queued",
    ]
  ) {
    assertEquals(isEligible(s), true, s);
    assertEquals(isRejected(s), false, s);
  }
});

Deno.test("SQL mirror: reject set covers no_show/started/terminal", () => {
  for (
    const s of [
      "no_show",
      "in_progress",
      "started",
      "completed",
      "customer_cancelled",
      "expired",
      "declined",
      "failed",
    ]
  ) {
    assertEquals(isRejected(s), true, s);
    assertEquals(isEligible(s), false, s);
  }
});

Deno.test("SQL mirror: arrays dedupe contract", () => {
  const prev = ["a", "b"];
  const next = [...new Set([...prev, "b", "c"])];
  assertEquals(next, ["a", "b", "c"]);
});
