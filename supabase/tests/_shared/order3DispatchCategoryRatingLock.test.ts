/**
 * Order 3 lock: Pet-Friendly offers need the assignment AND the driver's own
 * toggle; offers carry only the aggregate customer rating (never identity).
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  mapPassengerOfferRating,
  resolvePassengerOfferRating,
  UNKNOWN_PASSENGER_OFFER_RATING,
} from "../../functions/_shared/passengerOfferRating.ts";

const dispatch = await Deno.readTextFile(
  new URL("../../functions/auto-dispatch/index.ts", import.meta.url),
);
const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20261210120000_customer_trip_stats_service_role.sql",
    import.meta.url,
  ),
);

Deno.test("pet-friendly: driver_controllable category also requires drivers.is_pet_friendly", () => {
  assert(dispatch.includes('.select("is_default, driver_controllable")'));
  assert(dispatch.includes('vType?.driver_controllable === true'));
  assert(/\.eq\("is_pet_friendly", true\)/.test(dispatch));
  // Fail closed when the toggle can't be read.
  assert(dispatch.includes("toggleErr ? [] :"));
});

Deno.test("pet-friendly toggle OFF is excluded on the idle and stacked gates", () => {
  assert(dispatch.includes(".filter(d => !petToggleOffDriverIds.has(d.id))"));
  assert(dispatch.includes('"pet_friendly_toggle_off"'));
  assert(dispatch.includes('"stacked_pet_friendly_toggle_off"'));
});

Deno.test("assigned-category gate is unchanged (non-default requires enabled assignment)", () => {
  assert(dispatch.includes('.eq("is_enabled", true)'));
  assert(dispatch.includes('"missing_required_vehicle_category"'));
  assert(dispatch.includes('"stacked_missing_required_vehicle_category"'));
});

Deno.test("every auto-dispatch offer snapshot carries the aggregate customer rating", () => {
  assert(dispatch.includes("resolvePassengerOfferRating("));
  assert(/const dispatchSnapshotFields = \{[\s\S]{0,200}\.\.\.passengerOfferRating,/.test(dispatch));
});

Deno.test("rating grant is service_role only", () => {
  assert(migration.includes("TO service_role;"));
  assert(!/TO\s+(authenticated|anon|public)/i.test(migration));
});

Deno.test("rated customer → average + count", () => {
  assertEquals(mapPassengerOfferRating({ avg_rating: "4.857", rating_count: 24 }), {
    passenger_rating: 4.86,
    passenger_rating_count: 24,
  });
});

Deno.test("unrated customer → null rating, count 0 (New customer)", () => {
  assertEquals(mapPassengerOfferRating({ avg_rating: null, rating_count: 0, total_trips: 0 }), {
    passenger_rating: null,
    passenger_rating_count: 0,
  });
});

Deno.test("unknown / out-of-range → both null (hidden, never faked)", () => {
  assertEquals(mapPassengerOfferRating(null), UNKNOWN_PASSENGER_OFFER_RATING);
  assertEquals(mapPassengerOfferRating({ avg_rating: 0, rating_count: 3 }), UNKNOWN_PASSENGER_OFFER_RATING);
  assertEquals(mapPassengerOfferRating({ avg_rating: 4.5 }), UNKNOWN_PASSENGER_OFFER_RATING);
});

Deno.test("RPC failure fails soft to unknown; no passenger → unknown without a call", async () => {
  let calls = 0;
  const failing = {
    rpc: () => {
      calls++;
      return Promise.resolve({ data: null, error: { message: "permission denied" } });
    },
  };
  assertEquals(await resolvePassengerOfferRating(failing, "p1"), UNKNOWN_PASSENGER_OFFER_RATING);
  assertEquals(await resolvePassengerOfferRating(failing, null), UNKNOWN_PASSENGER_OFFER_RATING);
  assertEquals(calls, 1);
  const ok = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      assertEquals(fn, "get_customer_trip_stats");
      assertEquals(args, { _passenger_id: "p2" });
      return Promise.resolve({ data: [{ avg_rating: 5, rating_count: 2 }], error: null });
    },
  };
  assertEquals(await resolvePassengerOfferRating(ok, "p2"), {
    passenger_rating: 5,
    passenger_rating_count: 2,
  });
});
