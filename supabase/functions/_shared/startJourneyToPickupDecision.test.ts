import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveStartJourneyToPickupDecision } from "./startJourneyToPickupDecision.ts";

Deno.test("on-demand driver_assigned → en_route_to_pickup", () => {
  const d = resolveStartJourneyToPickupDecision({ status: "driver_assigned" });
  assertEquals(d.kind, "transition");
  if (d.kind === "transition") {
    assertEquals(d.to, "en_route_to_pickup");
    assertEquals(d.from, "driver_assigned");
  }
});

Deno.test("duplicate start journey is idempotent", () => {
  const d = resolveStartJourneyToPickupDecision({
    status: "en_route_to_pickup",
  });
  assertEquals(d, { kind: "idempotent", status: "en_route_to_pickup" });
});

Deno.test("unassigned / wrong lifecycle rejected", () => {
  for (const status of [
    "searching",
    "offered",
    "searching_new_driver",
    "in_progress",
    "cancelled",
    "completed",
  ]) {
    const d = resolveStartJourneyToPickupDecision({ status });
    assertEquals(d.kind, "reject");
  }
});

Deno.test("arrived blocks start journey", () => {
  const d = resolveStartJourneyToPickupDecision({
    status: "driver_assigned",
    arrivedAt: "2026-08-03T12:00:00.000Z",
  });
  assertEquals(d.kind, "reject");
});

// Keep Deno assert import used if future async tests are added.
void assertRejects;
