/**
 * Formal lifecycle transition matrix tests — Phase 1 gate.
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertTripLifecycleInvariants,
  mapEdgeActionToMatrixAction,
  resolveLifecycleTransition,
  type LifecycleTransitionContext,
} from "./tripLifecycleTransitionMatrix.ts";
import type { TripStopRecord } from "./tripLifecycle.ts";

function stop(
  stop_index: number,
  type: TripStopRecord["type"],
  status: TripStopRecord["status"],
  arrived_at?: string | null,
): TripStopRecord {
  return { stop_index, type, status, arrived_at };
}

const pickupDrop: TripStopRecord[] = [
  stop(0, "pickup", "completed"),
  stop(1, "dropoff", "current"),
];

const multiStops: TripStopRecord[] = [
  stop(0, "pickup", "completed"),
  stop(1, "stop", "current"),
  stop(2, "dropoff", "pending"),
];

const DRIVER = "11111111-1111-4111-8111-111111111111";

function ctx(
  partial: LifecycleTransitionContext,
): LifecycleTransitionContext {
  return {
    assignment: {
      driver_id: DRIVER,
      confirmed_driver_id: DRIVER,
      is_driver_active_trip: true,
    },
    acting_driver_id: DRIVER,
    dispatch_status: "assigned",
    ...partial,
  };
}

Deno.test("legal: accept → arrive → start → complete", () => {
  const accepted = resolveLifecycleTransition(
    "accept_offer",
    "driver",
    ctx({ status: "offered", assignment: {}, acting_driver_id: DRIVER }),
  );
  assertEquals(accepted.allowed, true);
  assertEquals(accepted.resulting_status, "accepted");
  assertEquals(accepted.resulting_dispatch_status, "assigned");

  const arrive = resolveLifecycleTransition(
    "arrive_pickup",
    "driver",
    ctx({ status: "accepted" }),
  );
  assertEquals(arrive.allowed, true);
  assertEquals(arrive.resulting_status, "arrived_at_pickup");

  const start = resolveLifecycleTransition(
    "start_trip",
    "driver",
    ctx({ status: "arrived_at_pickup", arrived_at: "t" }),
    [stop(0, "pickup", "current"), stop(1, "dropoff", "pending")],
  );
  assertEquals(start.allowed, true);
  assertEquals(start.resulting_status, "in_progress");

  const complete = resolveLifecycleTransition(
    "complete_trip",
    "driver",
    ctx({ status: "in_progress", started_at: "t", current_stop_index: 1 }),
    pickupDrop,
  );
  assertEquals(complete.allowed, true);
  assertEquals(complete.resulting_status, "completed");
  assertEquals(complete.resulting_dispatch_status, "completed");
  assertEquals(complete.side_effects?.payment, "capture_pending");
});

Deno.test("illegal: start before arrive rejected", () => {
  const r = resolveLifecycleTransition(
    "start_trip",
    "driver",
    ctx({ status: "accepted" }),
  );
  assertEquals(r.allowed, false);
  assertEquals(r.error_code, "INVALID_TRIP_STATE");
});

Deno.test("illegal: wrong driver rejected", () => {
  const r = resolveLifecycleTransition(
    "arrive_pickup",
    "driver",
    ctx({
      status: "accepted",
      acting_driver_id: "22222222-2222-4222-8222-222222222222",
    }),
  );
  assertEquals(r.allowed, false);
  assertEquals(r.error_code, "NOT_ASSIGNED_DRIVER");
});

Deno.test("idempotent: arrive twice", () => {
  const r = resolveLifecycleTransition(
    "arrive_pickup",
    "driver",
    ctx({ status: "arrived_at_pickup", arrived_at: "t", waiting: { arrived_at: "t" } }),
  );
  assertEquals(r.allowed, true);
  assertEquals(r.idempotent, true);
});

Deno.test("idempotent: complete twice", () => {
  const r = resolveLifecycleTransition(
    "complete_trip",
    "driver",
    ctx({ status: "completed", completed_at: "t", started_at: "t" }),
    pickupDrop,
  );
  assertEquals(r.allowed, true);
  assertEquals(r.idempotent, true);
});

Deno.test("terminal blocks progression", () => {
  for (const status of ["cancelled", "no_show", "expired", "completed"]) {
    if (status === "completed") continue;
    const r = resolveLifecycleTransition(
      "arrive_pickup",
      "driver",
      ctx({ status }),
    );
    assertEquals(r.allowed, false, status);
  }
});

Deno.test("multi-stop: complete blocked while intermediate pending", () => {
  const r = resolveLifecycleTransition(
    "complete_trip",
    "driver",
    ctx({ status: "in_progress", started_at: "t", current_stop_index: 1 }),
    multiStops,
  );
  assertEquals(r.allowed, false);
  assertEquals(r.error_code, "STOPS_INCOMPLETE");
});

Deno.test("driver cancel before start → rematch not terminal customer cancel", () => {
  const r = resolveLifecycleTransition(
    "driver_cancel_before_start",
    "driver",
    ctx({ status: "accepted" }),
  );
  assertEquals(r.allowed, true);
  assertEquals(r.resulting_status, "searching_new_driver");
  assertEquals(r.resulting_dispatch_status, "searching_new_driver");
  assertEquals(r.side_effects?.assignment, "exclude_and_clear");
  assertEquals(r.next_state, "OFFERED");
});

Deno.test("driver cancel after start → terminal", () => {
  const r = resolveLifecycleTransition(
    "driver_cancel_after_start",
    "driver",
    ctx({ status: "in_progress", started_at: "t" }),
  );
  assertEquals(r.allowed, true);
  assertEquals(r.resulting_status, "cancelled");
  assertEquals(r.resulting_dispatch_status, "cancelled");
});

Deno.test("no-show clears assignment and dispatch", () => {
  const r = resolveLifecycleTransition(
    "passenger_no_show",
    "driver",
    ctx({
      status: "pickup_waiting",
      arrived_at: "t",
      waiting: { pickup_arrived_at: "t" },
    }),
  );
  assertEquals(r.allowed, true);
  assertEquals(r.resulting_status, "no_show");
  assertEquals(r.resulting_dispatch_status, "no_show");
  assertEquals(r.side_effects?.assignment, "clear");
  assertEquals(r.side_effects?.customer_live_location, "clear");
});

Deno.test("no-show before arrive rejected", () => {
  const r = resolveLifecycleTransition(
    "passenger_no_show",
    "driver",
    ctx({ status: "accepted" }),
  );
  assertEquals(r.allowed, false);
  assertEquals(r.error_code, "NO_SHOW_NOT_ELIGIBLE");
});

Deno.test("queued cannot arrive/start until promoted", () => {
  const arrive = resolveLifecycleTransition(
    "arrive_pickup",
    "driver",
    ctx({
      status: "queued",
      queue: { is_queued: true, stack_position: 1 },
      assignment: { is_driver_active_trip: false, driver_id: DRIVER, confirmed_driver_id: DRIVER },
    }),
  );
  assertEquals(arrive.allowed, false);
  assertEquals(arrive.error_code, "INVALID_QUEUE_STATE");

  const promote = resolveLifecycleTransition(
    "promote_queued_trip",
    "system",
    ctx({
      status: "queued",
      queue: { is_queued: true },
      assignment: { driver_id: DRIVER, confirmed_driver_id: DRIVER, is_driver_active_trip: false },
      acting_driver_id: null,
    }),
  );
  assertEquals(promote.allowed, true);
  assertEquals(promote.resulting_status, "accepted");
  assertEquals(promote.side_effects?.queue, "promote_to_active");
});

Deno.test("accept stacked enqueues without replacing", () => {
  const r = resolveLifecycleTransition(
    "accept_stacked",
    "driver",
    ctx({ status: "offered", assignment: {}, acting_driver_id: DRIVER }),
  );
  assertEquals(r.allowed, true);
  assertEquals(r.resulting_status, "queued");
  assertEquals(r.side_effects?.queue, "enqueue");
});

Deno.test("cancel queued rematches without terminating active path", () => {
  const r = resolveLifecycleTransition(
    "cancel_queued_trip",
    "driver",
    ctx({
      status: "queued",
      queue: { is_queued: true },
      assignment: { driver_id: DRIVER, confirmed_driver_id: DRIVER, is_driver_active_trip: false },
    }),
  );
  assertEquals(r.allowed, true);
  assertEquals(r.resulting_dispatch_status, "stacked_rebroadcasting");
  assertEquals(r.side_effects?.queue, "cancel_queued");
});

Deno.test("invariants: completed+assigned dispatch", () => {
  const inv = assertTripLifecycleInvariants(
    ctx({ status: "completed", dispatch_status: "assigned", completed_at: "t" }),
  );
  assertEquals(inv.ok, false);
  assertEquals(inv.violations.includes("completed_with_active_dispatch"), true);
});

Deno.test("invariants: no_show with assigned driver", () => {
  const inv = assertTripLifecycleInvariants(
    ctx({ status: "no_show", dispatch_status: "no_show" }),
  );
  assertEquals(inv.ok, false);
  assertEquals(inv.violations.includes("no_show_with_assigned_driver"), true);
});

Deno.test("invariants: queued occupying active", () => {
  const inv = assertTripLifecycleInvariants(
    ctx({
      status: "queued",
      queue: { is_queued: true },
      assignment: {
        driver_id: DRIVER,
        confirmed_driver_id: DRIVER,
        is_driver_active_trip: true,
      },
    }),
  );
  assertEquals(inv.ok, false);
  assertEquals(inv.violations.includes("queued_trip_occupying_active_trip_state"), true);
});

Deno.test("status/dispatch pairings on success paths", () => {
  const complete = resolveLifecycleTransition(
    "complete_trip",
    "driver",
    ctx({ status: "in_progress", started_at: "t", current_stop_index: 1 }),
    pickupDrop,
  );
  assertEquals(complete.resulting_status, "completed");
  assertEquals(complete.resulting_dispatch_status, "completed");

  const noShow = resolveLifecycleTransition(
    "passenger_no_show",
    "driver",
    ctx({ status: "arrived_at_pickup", arrived_at: "t", waiting: { arrived_at: "t" } }),
  );
  assertEquals(noShow.resulting_status, "no_show");
  assertEquals(noShow.resulting_dispatch_status, "no_show");
});

Deno.test("edge action mapping: driver_cancel respects started flag", () => {
  assertEquals(
    mapEdgeActionToMatrixAction("driver_cancel", { tripStarted: false }),
    "driver_cancel_before_start",
  );
  assertEquals(
    mapEdgeActionToMatrixAction("driver_cancel", { tripStarted: true }),
    "driver_cancel_after_start",
  );
  assertEquals(mapEdgeActionToMatrixAction("cancel_queued_stacked"), "cancel_queued_trip");
});

Deno.test("modification stale version rejected", () => {
  const r = resolveLifecycleTransition(
    "in_trip_modification",
    "customer",
    ctx({
      status: "in_progress",
      started_at: "t",
      version: { trip_version: 3, client_trip_version: 2 },
    }),
  );
  assertEquals(r.allowed, false);
  assertEquals(r.error_code, "STALE_TRIP_VERSION");
});

Deno.test("payment capture idempotent when already captured", () => {
  const r = resolveLifecycleTransition(
    "payment_capture",
    "system",
    ctx({
      status: "completed",
      completed_at: "t",
      payment: { payment_status: "captured" },
      assignment: { is_driver_active_trip: false },
      acting_driver_id: null,
    }),
  );
  assertEquals(r.allowed, true);
  assertEquals(r.idempotent, true);
});

Deno.test("accept_scheduled converges to assigned", () => {
  const r = resolveLifecycleTransition(
    "accept_scheduled",
    "driver",
    ctx({ status: "searching", acting_driver_id: "d1" }),
  );
  assertEquals(r.allowed, true);
  assertEquals(r.resulting_status === "accepted" || r.resulting_status === "confirmed" ||
    r.resulting_status === "driver_assigned", true);
});

Deno.test("customer_cancel terminates", () => {
  const r = resolveLifecycleTransition(
    "customer_cancel",
    "customer",
    ctx({ status: "accepted", acting_driver_id: "d1" }),
  );
  assertEquals(r.allowed, true);
  assertEquals(r.resulting_status, "cancelled");
});

Deno.test("admin_cancel terminates", () => {
  const r = resolveLifecycleTransition(
    "admin_cancel",
    "admin",
    ctx({ status: "in_progress", started_at: "t", acting_driver_id: "d1" }),
  );
  assertEquals(r.allowed, true);
  assertEquals(r.resulting_status, "cancelled");
});

Deno.test("settlement_complete after completed", () => {
  const r = resolveLifecycleTransition(
    "settlement_complete",
    "system",
    ctx({
      status: "completed",
      completed_at: "t",
      payment: { payment_status: "captured" },
      assignment: { is_driver_active_trip: false },
      acting_driver_id: null,
    }),
  );
  assertEquals(r.allowed, true);
});

Deno.test("invariant violations block progression but allow corrective cancel", () => {
  const broken = ctx({
    status: "completed",
    dispatch_status: "assigned",
    completed_at: "t",
    assignment: { driver_id: DRIVER, confirmed_driver_id: DRIVER },
  });
  const blocked = resolveLifecycleTransition("start_trip", "driver", broken);
  assertEquals(blocked.allowed, false);
  assertEquals(blocked.error_code, "INVARIANT_VIOLATION");

  const heal = resolveLifecycleTransition("admin_cancel", "admin", broken);
  assertEquals(heal.error_code !== "INVARIANT_VIOLATION", true);
});

Deno.test("invariants: cancelled with assigned driver", () => {
  const inv = assertTripLifecycleInvariants(
    ctx({
      status: "cancelled",
      dispatch_status: "cancelled",
      assignment: { driver_id: DRIVER, confirmed_driver_id: DRIVER },
    }),
  );
  assertEquals(inv.ok, false);
  assertEquals(inv.violations.includes("cancelled_with_assigned_driver"), true);
});

Deno.test("invariants: in_progress without assigned driver", () => {
  const inv = assertTripLifecycleInvariants(
    ctx({
      status: "in_progress",
      started_at: "t",
      dispatch_status: "assigned",
      assignment: {},
      acting_driver_id: null,
    }),
  );
  assertEquals(inv.ok, false);
  assertEquals(inv.violations.includes("in_progress_without_assigned_driver"), true);
});

Deno.test("invariants: active driver points to different trip assignment", () => {
  const inv = assertTripLifecycleInvariants(
    {
      status: "accepted",
      dispatch_status: "assigned",
      trip_id: "trip-a",
      assignment: {
        driver_id: DRIVER,
        confirmed_driver_id: DRIVER,
        is_driver_active_trip: true,
        driver_current_trip_id: "trip-b",
      } as LifecycleTransitionContext["assignment"],
      acting_driver_id: DRIVER,
    } as LifecycleTransitionContext,
  );
  assertEquals(inv.ok, false);
  assertEquals(
    inv.violations.includes("active_driver_points_to_different_trip_assignment"),
    true,
  );
});

Deno.test("arrive_stop and drive_to_next succeed on in-progress multi-stop", () => {
  const stops = [
    { stop_index: 1, type: "stop" as const, status: "pending" as const },
    { stop_index: 2, type: "dropoff" as const, status: "pending" as const },
  ];
  const base = ctx({
    status: "in_progress",
    started_at: "t",
    dispatch_status: "assigned",
    assignment: { driver_id: DRIVER, confirmed_driver_id: DRIVER },
  });
  const arrive = resolveLifecycleTransition("arrive_stop", "driver", base, stops);
  assertEquals(arrive.error_code !== "INVARIANT_VIOLATION", true);

  const leave = resolveLifecycleTransition("drive_to_next", "driver", base, [
    { stop_index: 1, type: "stop", status: "completed" },
    { stop_index: 2, type: "dropoff", status: "pending" },
  ]);
  assertEquals(leave.error_code !== "INVARIANT_VIOLATION", true);
});

Deno.test("status/dispatch pairings table covers production set", async () => {
  const { EXPECTED_STATUS_DISPATCH_PAIRINGS } = await import(
    "./tripLifecycleTransitionMatrix.ts"
  );
  const statuses = EXPECTED_STATUS_DISPATCH_PAIRINGS.map((r) => r.status);
  for (const required of [
    "accepted",
    "arrived_at_pickup",
    "pickup_waiting",
    "in_progress",
    "queued",
    "completed",
    "cancelled",
    "no_show",
    "searching_new_driver",
  ]) {
    assertEquals(statuses.includes(required), true);
  }
});

Deno.test("admin force complete allowed outside driver physical preconditions", () => {
  const r = resolveLifecycleTransition(
    "complete_trip",
    "admin",
    ctx({ status: "accepted", dispatch_status: "assigned" }),
  );
  assertEquals(r.allowed, true);
  assertEquals(r.resulting_status, "completed");
  assertEquals(r.resulting_dispatch_status, "completed");
});

Deno.test("admin cannot force-complete cancelled trip", () => {
  const r = resolveLifecycleTransition(
    "complete_trip",
    "admin",
    ctx({
      status: "cancelled",
      dispatch_status: "cancelled",
      assignment: { is_driver_active_trip: false },
      acting_driver_id: null,
    }),
  );
  assertEquals(r.allowed, false);
  assertEquals(r.error_code, "INVALID_TRIP_STATE");
});
