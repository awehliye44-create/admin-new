/**
 * deno test --allow-read supabase/functions/_shared/customerLiveTripEligibilitySSOT.test.ts
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveCustomerLiveTripEligibility } from "./customerLiveTripEligibilitySSOT.ts";

const NOW = Date.parse("2026-06-01T12:00:00Z");

Deno.test("scheduled hold statuses never eligible", () => {
  for (const status of ["scheduled", "scheduled_committed"]) {
    const r = resolveCustomerLiveTripEligibility({
      status,
      is_scheduled: true,
      scheduled_at: "2026-06-01T18:00:00Z",
      nowMs: NOW,
    });
    assertEquals(r.eligible, false);
    assertEquals(r.terminal, false);
  }
});

Deno.test("marketplace / legacy accepted scheduled pre-activation never eligible", () => {
  for (const scheduled_status of [
    "marketplace_accepted",
    "legacy_accepted",
    "accepted",
    "confirmed",
    "driver_assigned",
    "pending_assignment",
    "pending_departure_ack",
    "awaiting_departure_ack",
    "awaiting_activation_accept",
    "admin_held",
    "scheduled_committed",
  ]) {
    const r = resolveCustomerLiveTripEligibility({
      status: "accepted",
      is_scheduled: true,
      scheduled_status,
      scheduled_at: "2026-06-01T18:00:00Z",
      confirmed_driver_id: "00000000-0000-4000-8000-000000000099",
      nowMs: NOW,
    });
    assertEquals(r.eligible, false, scheduled_status);
  }
});

Deno.test("on-demand searching is eligible", () => {
  const r = resolveCustomerLiveTripEligibility({
    status: "searching",
    is_scheduled: false,
    nowMs: NOW,
  });
  assertEquals(r.eligible, true);
  assertEquals(r.reason, "active_searching");
});

Deno.test("scheduled rematch after window + instant mode is eligible", () => {
  const r = resolveCustomerLiveTripEligibility({
    status: "searching_new_driver",
    is_scheduled: true,
    dispatch_mode: "instant",
    scheduled_status: "converted_to_instant",
    nowMs: NOW,
  });
  assertEquals(r.eligible, true);
});

Deno.test("en_route after scheduled window reached is eligible", () => {
  const r = resolveCustomerLiveTripEligibility({
    status: "en_route_to_pickup",
    is_scheduled: true,
    scheduled_status: "converted_to_instant",
    dispatch_mode: "instant",
    confirmed_driver_id: "00000000-0000-4000-8000-000000000001",
    nowMs: NOW,
  });
  assertEquals(r.eligible, true);
  assertEquals(r.reason, "active_journey");
});

Deno.test("terminal is not eligible", () => {
  const r = resolveCustomerLiveTripEligibility({
    status: "completed",
    nowMs: NOW,
  });
  assertEquals(r.eligible, false);
  assertEquals(r.terminal, true);
});

Deno.test("future scheduled_at before broadcast window not eligible even if searching", () => {
  const r = resolveCustomerLiveTripEligibility({
    status: "searching",
    is_scheduled: true,
    scheduled_status: "awaiting_activation_accept",
    scheduled_at: "2026-06-01T18:00:00Z",
    nowMs: NOW,
  });
  assertEquals(r.eligible, false);
});
