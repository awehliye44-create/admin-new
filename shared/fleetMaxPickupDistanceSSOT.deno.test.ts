import {
  assertEquals,
  assertAlmostEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  EXCEEDS_FLEET_MAX_PICKUP_DISTANCE,
  FLEET_MAX_PICKUP_DISTANCE_MILES_FAILSAFE,
  FLEET_MAX_PICKUP_MILES_TO_METERS,
  exceedsFleetMaxPickupDistance,
  fleetMaxPickupDistanceMeters,
  fleetMaxPickupMetersFromDispatchRow,
  fleetMaxPickupMilesFromDispatchRow,
  resolveFleetMaxPickupDistanceMiles,
  validateFleetMaxPickupDistanceMiles,
} from "./fleetMaxPickupDistanceSSOT.ts";

Deno.test("failsafe is 17.8 miles", () => {
  assertEquals(FLEET_MAX_PICKUP_DISTANCE_MILES_FAILSAFE, 17.8);
});

Deno.test("resolveFleetMaxPickupDistanceMiles: valid values pass through", () => {
  assertEquals(resolveFleetMaxPickupDistanceMiles(17.8), 17.8);
  assertEquals(resolveFleetMaxPickupDistanceMiles(10), 10);
  assertEquals(resolveFleetMaxPickupDistanceMiles("12.5"), 12.5);
});

Deno.test("resolveFleetMaxPickupDistanceMiles: invalid/missing → failsafe (never uncapped)", () => {
  for (const raw of [null, undefined, "", " ", NaN, 0, -1, -17.8, "abc", {}]) {
    assertEquals(
      resolveFleetMaxPickupDistanceMiles(raw),
      FLEET_MAX_PICKUP_DISTANCE_MILES_FAILSAFE,
      `expected failsafe for ${Deno.inspect(raw)}`,
    );
  }
});

Deno.test("fleetMaxPickupDistanceMeters converts miles with international mile", () => {
  assertAlmostEquals(
    fleetMaxPickupDistanceMeters(17.8),
    17.8 * FLEET_MAX_PICKUP_MILES_TO_METERS,
    0.01,
  );
  assertAlmostEquals(
    fleetMaxPickupDistanceMeters(null),
    17.8 * FLEET_MAX_PICKUP_MILES_TO_METERS,
    0.01,
  );
});

Deno.test("fleetMaxPickupMilesFromDispatchRow reads column or failsafe", () => {
  assertEquals(
    fleetMaxPickupMilesFromDispatchRow({ fleet_max_pickup_distance_miles: 20 }),
    20,
  );
  assertEquals(fleetMaxPickupMilesFromDispatchRow({}), FLEET_MAX_PICKUP_DISTANCE_MILES_FAILSAFE);
  assertEquals(fleetMaxPickupMilesFromDispatchRow(null), FLEET_MAX_PICKUP_DISTANCE_MILES_FAILSAFE);
});

Deno.test("exceedsFleetMaxPickupDistance: boundary at exactly max is allowed", () => {
  const maxM = fleetMaxPickupDistanceMeters(17.8);
  assertEquals(exceedsFleetMaxPickupDistance(maxM, 17.8), false);
  assertEquals(exceedsFleetMaxPickupDistance(maxM + 1, 17.8), true);
  assertEquals(exceedsFleetMaxPickupDistance(19_000, null), false); // ~11.8 mi < 17.8
  assertEquals(exceedsFleetMaxPickupDistance(30_000, null), true); // ~18.6 mi > 17.8
});

Deno.test("validateFleetMaxPickupDistanceMiles Admin range", () => {
  assertEquals(validateFleetMaxPickupDistanceMiles(17.8).length, 0);
  assertEquals(validateFleetMaxPickupDistanceMiles(1).length, 0);
  assertEquals(validateFleetMaxPickupDistanceMiles(100).length, 0);
  assertEquals(validateFleetMaxPickupDistanceMiles(null)[0]?.code, "required");
  assertEquals(validateFleetMaxPickupDistanceMiles(0)[0]?.code, "out_of_range");
  assertEquals(validateFleetMaxPickupDistanceMiles(101)[0]?.code, "out_of_range");
});

Deno.test("canonical reject reason constant is stable", () => {
  assertEquals(EXCEEDS_FLEET_MAX_PICKUP_DISTANCE, "exceeds_fleet_max_pickup_distance");
});

Deno.test("fleetMaxPickupMetersFromDispatchRow uses failsafe when column absent", () => {
  assertAlmostEquals(
    fleetMaxPickupMetersFromDispatchRow(undefined),
    17.8 * FLEET_MAX_PICKUP_MILES_TO_METERS,
    0.01,
  );
});
