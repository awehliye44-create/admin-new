import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isDriverAssignedToTrip,
  isPrePickupDriverRematchEligibleDbStatus,
  PRE_PICKUP_DRIVER_REMATCH_DB_STATUSES,
  resolveNextRematchBroadcastRound,
} from "./driverCancelRematch.ts";

Deno.test("pre-start statuses are rematch-eligible", () => {
  for (const status of [
    "driver_assigned",
    "en_route_to_pickup",
    "arrived_at_pickup",
  ]) {
    assertEquals(isPrePickupDriverRematchEligibleDbStatus(status), true);
  }
  assertEquals(
    PRE_PICKUP_DRIVER_REMATCH_DB_STATUSES.includes("driver_assigned"),
    true,
  );
});

Deno.test("in_progress / completed are not rematch-eligible", () => {
  assertEquals(isPrePickupDriverRematchEligibleDbStatus("in_progress"), false);
  assertEquals(isPrePickupDriverRematchEligibleDbStatus("completed"), false);
  assertEquals(isPrePickupDriverRematchEligibleDbStatus("cancelled"), false);
});

Deno.test("assigned driver check rejects wrong driver", () => {
  assertEquals(
    isDriverAssignedToTrip({ confirmed_driver_id: "drv-a" }, "drv-a"),
    true,
  );
  assertEquals(
    isDriverAssignedToTrip({ confirmed_driver_id: "drv-a" }, "drv-b"),
    false,
  );
  assertEquals(
    isDriverAssignedToTrip({ confirmed_driver_id: null }, "drv-a"),
    false,
  );
});

Deno.test("rematch broadcast round increments once", () => {
  assertEquals(resolveNextRematchBroadcastRound(0), 1);
  assertEquals(resolveNextRematchBroadcastRound(3), 4);
});
