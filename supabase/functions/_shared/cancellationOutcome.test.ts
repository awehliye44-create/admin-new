/**
 * Cancellation outcome resolver tests — Phase 2 gate.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveCancellationOutcome } from "./cancellationOutcome.ts";

const DRIVER = "11111111-1111-4111-8111-111111111111";

Deno.test("driver pre-start → rematch (not terminal cancel)", () => {
  const outcome = resolveCancellationOutcome({
    actor: "driver",
    status: "accepted",
    driverId: DRIVER,
    confirmedDriverId: DRIVER,
    arrivedAt: null,
    startedAt: null,
  });
  assertEquals(outcome.kind, "rematch");
  assertEquals(outcome.lifecycle_action, "driver_cancel_before_start");
  assertEquals(outcome.rematch_eligible, true);
  assertEquals(outcome.exclude_cancelling_driver, true);
  assertEquals(outcome.clear_assignment, true);
  assertEquals(outcome.resulting_status, "searching_new_driver");
  assertEquals(outcome.resulting_dispatch_status, "searching_new_driver");
});

Deno.test("driver post-start → terminal cancel", () => {
  const outcome = resolveCancellationOutcome({
    actor: "driver",
    status: "in_progress",
    driverId: DRIVER,
    confirmedDriverId: DRIVER,
    startedAt: "2026-07-26T12:00:00Z",
  });
  assertEquals(outcome.kind, "terminal_cancel");
  assertEquals(outcome.lifecycle_action, "driver_cancel_after_start");
  assertEquals(outcome.rematch_eligible, false);
  assertEquals(outcome.exclude_cancelling_driver, false);
  assertEquals(outcome.clear_assignment, true);
  assertEquals(outcome.resulting_status, "cancelled");
  assertEquals(outcome.resulting_dispatch_status, "cancelled");
  assertEquals(outcome.payment_hint, "cancel_auth");
});

Deno.test("customer cancel → terminal", () => {
  const outcome = resolveCancellationOutcome({
    actor: "rider",
    status: "accepted",
    driverId: DRIVER,
    confirmedDriverId: DRIVER,
  });
  assertEquals(outcome.kind, "terminal_cancel");
  assertEquals(outcome.lifecycle_action, "customer_cancel");
  assertEquals(outcome.rematch_eligible, false);
  assertEquals(outcome.resulting_status, "cancelled");
  assertEquals(outcome.resulting_dispatch_status, "cancelled");
});

Deno.test("admin cancel → terminal", () => {
  const outcome = resolveCancellationOutcome({
    actor: "admin",
    status: "arrived_at_pickup",
    driverId: DRIVER,
    confirmedDriverId: DRIVER,
    arrivedAt: "2026-07-26T12:00:00Z",
  });
  assertEquals(outcome.kind, "terminal_cancel");
  assertEquals(outcome.lifecycle_action, "admin_cancel");
  assertEquals(outcome.resulting_status, "cancelled");
  assertEquals(outcome.resulting_dispatch_status, "cancelled");
});

Deno.test("no-show → no_show dispatch (not cancelled)", () => {
  const outcome = resolveCancellationOutcome({
    actor: "driver",
    status: "arrived_at_pickup",
    driverId: DRIVER,
    confirmedDriverId: DRIVER,
    arrivedAt: "2026-07-26T12:00:00Z",
    isNoShow: true,
  });
  assertEquals(outcome.kind, "no_show");
  assertEquals(outcome.lifecycle_action, "passenger_no_show");
  assertEquals(outcome.rematch_eligible, false);
  assertEquals(outcome.clear_assignment, true);
  assertEquals(outcome.resulting_status, "no_show");
  assertEquals(outcome.resulting_dispatch_status, "no_show");
  assertEquals(outcome.payment_hint, "no_show_fee");
});

Deno.test("idempotent terminal when already cancelled", () => {
  const outcome = resolveCancellationOutcome({
    actor: "rider",
    status: "cancelled",
    dispatchStatus: "cancelled",
  });
  assertEquals(outcome.kind, "terminal_cancel");
  assertEquals(outcome.allowed, true);
  assertEquals(outcome.idempotent, true);
  assertEquals(outcome.resulting_status, "cancelled");
});

Deno.test("idempotent no_show when already no_show", () => {
  const outcome = resolveCancellationOutcome({
    actor: "driver",
    status: "no_show",
    dispatchStatus: "no_show",
    isNoShow: true,
    driverId: DRIVER,
    confirmedDriverId: DRIVER,
  });
  assertEquals(outcome.kind, "no_show");
  assertEquals(outcome.allowed, true);
  assertEquals(outcome.idempotent, true);
  assertEquals(outcome.resulting_status, "no_show");
  assertEquals(outcome.resulting_dispatch_status, "no_show");
});
