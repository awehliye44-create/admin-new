import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isAcceptLifecycleAction,
  resolveCanonicalTripLifecycleState,
  validateTripActionTransition,
  validateTripStopsProgression,
  type TripStopRecord,
} from "./tripLifecycle.ts";

function stop(
  stop_index: number,
  type: TripStopRecord["type"],
  status: TripStopRecord["status"],
  arrived_at?: string | null,
): TripStopRecord {
  return { stop_index, type, status, arrived_at };
}

const pickupOnly: TripStopRecord[] = [
  stop(0, "pickup", "completed"),
  stop(1, "dropoff", "current"),
];

const oneStopTrip: TripStopRecord[] = [
  stop(0, "pickup", "completed"),
  stop(1, "stop", "current"),
  stop(2, "dropoff", "pending"),
];

const multiStopTrip: TripStopRecord[] = [
  stop(0, "pickup", "completed"),
  stop(1, "stop", "completed"),
  stop(2, "stop", "current"),
  stop(3, "dropoff", "pending"),
];

Deno.test("normal trip — accept assigns driver, does not start trip", () => {
  const offered = validateTripActionTransition("accept_offer", { status: "offered" });
  assertEquals(offered.allowed, true);
  assertEquals(offered.next_state, "DRIVER_ASSIGNED");
});

Deno.test("normal trip — full happy path transitions", () => {
  const arrive = validateTripActionTransition("arrive_pickup", { status: "driver_assigned" });
  assertEquals(arrive.allowed, true);
  assertEquals(arrive.next_state, "ARRIVED_AT_PICKUP");

  const complete = validateTripActionTransition(
    "complete_trip",
    { status: "in_progress", started_at: "2026-01-01T00:05:00Z", current_stop_index: 1 },
    pickupOnly,
  );
  assertEquals(complete.allowed, true);
  assertEquals(complete.next_state, "COMPLETED");
});

Deno.test("multi-stop trip — complete blocked before final stop", () => {
  const blocked = validateTripActionTransition(
    "complete_trip",
    { status: "in_progress", started_at: "t", current_stop_index: 2 },
    multiStopTrip,
  );
  assertEquals(blocked.allowed, false);
});

Deno.test("invalid transition — driver_assigned to completed forbidden", () => {
  const result = validateTripActionTransition("complete_trip", { status: "driver_assigned" });
  assertEquals(result.allowed, false);
});

Deno.test("duplicate start idempotent allowed", () => {
  const result = validateTripActionTransition("start_trip", {
    status: "in_progress",
    started_at: "t",
  });
  assertEquals(result.allowed, true);
  assertEquals(result.idempotent, true);
});

Deno.test("all accept paths converge to DRIVER_ASSIGNED entry", () => {
  for (const action of ["accept_offer", "accept_fare", "accept_standard", "accept_stacked"] as const) {
    assertEquals(isAcceptLifecycleAction(action), true);
    const result = validateTripActionTransition(action, { status: "offered" });
    assertEquals(result.next_state, "DRIVER_ASSIGNED");
  }
});

Deno.test("resolve state — in progress at intermediate stop", () => {
  const state = resolveCanonicalTripLifecycleState(
    { status: "in_progress", started_at: "t", current_stop_index: 1 },
    oneStopTrip,
  );
  assertEquals(state, "EN_ROUTE_TO_STOP");
});

Deno.test("1 stop trip — start targets first intermediate", () => {
  const start = validateTripStopsProgression(
    "start_trip",
    { status: "arrived_at_pickup", arrived_at: "t" },
    [
      stop(0, "pickup", "current"),
      stop(1, "stop", "pending"),
      stop(2, "dropoff", "pending"),
    ],
  );
  assertEquals(start.next_state, "EN_ROUTE_TO_STOP");
});

Deno.test("cancelled trip blocks progression", () => {
  const result = validateTripActionTransition("arrive_pickup", { status: "cancelled" });
  assertEquals(result.allowed, false);
});

Deno.test("expired trip blocks progression", () => {
  const result = validateTripActionTransition("start_trip", { status: "expired" });
  assertEquals(result.allowed, false);
});
