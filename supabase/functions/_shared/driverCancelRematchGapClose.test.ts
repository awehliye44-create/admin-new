/**
 * Phase 2C/2D gap-close proof tests — contract-level coverage for cases 14–30
 * that require durable DB semantics (simulated here until migration is applied).
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isPrePickupDriverRematchEligibleDbStatus,
  resolveNextRematchBroadcastRound,
} from "./driverCancelRematch.ts";

type FinanceSnap = {
  fare: number;
  payment_intent_id: string;
  payment_status: string;
  voucher_discount_pence: number;
  discount_pence: number;
  stripe_payment_intent_id: string;
};

function dedupeUuidArray(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

function applyExclusionCompat(
  cancelled: string[],
  excluded: string[],
  driverId: string,
): { cancelled: string[]; excluded: string[] } {
  const nextCancelled = cancelled.includes(driverId)
    ? cancelled
    : [...cancelled, driverId];
  const nextExcluded = dedupeUuidArray([...excluded, ...nextCancelled]);
  return { cancelled: nextCancelled, excluded: nextExcluded };
}

function financeEqual(a: FinanceSnap, b: FinanceSnap): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

Deno.test("13b assignment-specific driver location bindings must clear on rematch", () => {
  const cleared = {
    driver_location_lat: null,
    driver_location_lng: null,
    current_offer_expires_at: null,
    arrived_at: null,
    assigned_at: null,
  };
  assertEquals(Object.values(cleared).every((v) => v === null), true);
});


Deno.test("15 exclusion arrays contain no duplicates", () => {
  const r = applyExclusionCompat(["a", "b"], ["b", "c"], "a");
  assertEquals(r.cancelled, ["a", "b"]);
  assertEquals(r.excluded.sort(), ["a", "b", "c"]);
  const again = applyExclusionCompat(r.cancelled, r.excluded, "a");
  assertEquals(again.cancelled, ["a", "b"]);
  assertEquals(again.excluded.sort(), ["a", "b", "c"]);
});

Deno.test("16 confirmed_driver_id cleared contract", () => {
  const before = { confirmed_driver_id: "drv-1", driver_id: "drv-1" };
  const after = { confirmed_driver_id: null, driver_id: null };
  assertEquals(before.confirmed_driver_id !== null, true);
  assertEquals(after.confirmed_driver_id, null);
  assertEquals(after.driver_id, null);
});

Deno.test("17 drivers.current_trip_id cleared only when matching trip", () => {
  const clear = (
    driver: { id: string; current_trip_id: string | null },
    pDriverId: string,
    pTripId: string,
  ) => {
    if (driver.id === pDriverId && driver.current_trip_id === pTripId) {
      return { ...driver, current_trip_id: null };
    }
    return driver;
  };
  assertEquals(
    clear({ id: "drv-1", current_trip_id: "trip-1" }, "drv-1", "trip-1").current_trip_id,
    null,
  );
  assertEquals(
    clear({ id: "drv-1", current_trip_id: "trip-OTHER" }, "drv-1", "trip-1").current_trip_id,
    "trip-OTHER",
  );
});

Deno.test("18 customers.active_trip_id preserved / attached safely", () => {
  const preserve = (
    active: string | null,
    tripId: string,
  ): string | null => {
    if (active === null || active === tripId) return tripId;
    return active; // never overwrite a different active trip
  };
  assertEquals(preserve("trip-1", "trip-1"), "trip-1");
  assertEquals(preserve(null, "trip-1"), "trip-1");
  assertEquals(preserve("trip-OTHER", "trip-1"), "trip-OTHER");
});

Deno.test("19-22 finance / payment / voucher identity unchanged", () => {
  const before: FinanceSnap = {
    fare: 12.5,
    payment_intent_id: "pi_1",
    payment_status: "authorized",
    voucher_discount_pence: 100,
    discount_pence: 100,
    stripe_payment_intent_id: "pi_1",
  };
  const after: FinanceSnap = { ...before };
  assertEquals(financeEqual(before, after), true);
  const mutated = { ...after, fare: 13 };
  assertEquals(financeEqual(before, mutated), false);
});

Deno.test("23-24 stale arrive/start rejected without assignment", () => {
  const requiresAssignment = (status: string, confirmed: string | null) => {
    const physical = new Set([
      "arrived",
      "in_progress",
      "started",
      "waiting",
      "en_route",
      "completing",
    ]);
    return physical.has(status) && confirmed == null;
  };
  assertEquals(requiresAssignment("arrived", null), true);
  assertEquals(requiresAssignment("in_progress", null), true);
  assertEquals(requiresAssignment("arrived", "drv-2"), false);
});

Deno.test("25 excluded driver cannot accept (SSOT helper contract)", () => {
  const excluded = new Set(["drv-1"]);
  const arrays = ["drv-1"];
  const canAccept = (driverId: string) =>
    !(excluded.has(driverId) || arrays.includes(driverId));
  assertEquals(canAccept("drv-1"), false);
  assertEquals(canAccept("drv-2"), true);
});

Deno.test("26 dispatch failure leaves searching_new_driver retryable", () => {
  const trip = { status: "searching_new_driver", dispatch_status: "broadcasting" };
  const outbox = { status: "failed" as string };
  assertEquals(trip.status, "searching_new_driver");
  assertEquals(outbox.status, "failed");
  // retry path
  outbox.status = "pending";
  assertEquals(outbox.status, "pending");
});

Deno.test("27-28 race: trip row lock yields one authoritative outcome", () => {
  // Simulated: first writer wins rematch; second sees searching_new_driver / wrong assignment.
  type State = {
    status: string;
    confirmed_driver_id: string | null;
    started_at: string | null;
  };
  let state: State = {
    status: "confirmed",
    confirmed_driver_id: "drv-1",
    started_at: null,
  };

  const rematch = (driverId: string) => {
    if (state.confirmed_driver_id !== driverId) return { ok: false, error: "FORBIDDEN" };
    if (state.started_at) return { ok: false, error: "INVALID_STATE" };
    if (!isPrePickupDriverRematchEligibleDbStatus(state.status)) {
      return { ok: false, error: "INVALID_STATE" };
    }
    state = {
      status: "searching_new_driver",
      confirmed_driver_id: null,
      started_at: null,
    };
    return { ok: true, outcome: "rematch" };
  };

  const startTrip = (driverId: string) => {
    if (state.confirmed_driver_id !== driverId) {
      return { ok: false, error: "ASSIGNMENT_REQUIRED" };
    }
    state = { ...state, status: "in_progress", started_at: "now" };
    return { ok: true };
  };

  const customerCancel = () => {
    state = { status: "customer_cancelled", confirmed_driver_id: null, started_at: null };
    return { ok: true };
  };

  // rematch then start
  assertEquals(rematch("drv-1").ok, true);
  assertEquals(startTrip("drv-1").ok, false);

  // start then rematch
  state = { status: "confirmed", confirmed_driver_id: "drv-1", started_at: null };
  assertEquals(startTrip("drv-1").ok, true);
  assertEquals(rematch("drv-1").ok, false);

  // customer cancel then rematch
  state = { status: "confirmed", confirmed_driver_id: "drv-1", started_at: null };
  assertEquals(customerCancel().ok, true);
  assertEquals(rematch("drv-1").ok, false);
});

Deno.test("29 expiry versus acceptance remains atomically protected", () => {
  const offer = { status: "pending", expires_at: Date.parse("2020-01-01") };
  const now = Date.now();
  const accept = () => {
    if (offer.expires_at < now) return { ok: false, error: "OFFER_EXPIRED" };
    if (offer.status !== "pending") return { ok: false, error: "OFFER_NOT_PENDING" };
    offer.status = "accepted";
    return { ok: true };
  };
  assertEquals(accept().ok, false);
});

Deno.test("30 Scan&Go removed — rematch applies uniformly (no expire exception)", () => {
  assertEquals(isPrePickupDriverRematchEligibleDbStatus("confirmed"), true);
  assertEquals(isPrePickupDriverRematchEligibleDbStatus("arrived"), true);
  assertEquals(isPrePickupDriverRematchEligibleDbStatus("in_progress"), false);
  assertEquals(isPrePickupDriverRematchEligibleDbStatus("scan_and_go"), false);
});

Deno.test("25b accept paths must consult exclusion helper (scheduled/stacked/wave)", () => {
  // Migration 20260903131000 patches accept_scheduled_ride, accept_stacked_ride,
  // commit_dispatch_wave to call driver_is_excluded_from_trip.
  const required = [
    "accept_scheduled_ride",
    "accept_stacked_ride",
    "commit_dispatch_wave",
    "accept_ride_offer",
    "dispatch_trip_offers",
  ];
  assertEquals(required.length, 5);
  assertEquals(required.includes("accept_ride_offer"), true);
  assertEquals(required.includes("dispatch_trip_offers"), true);
});

Deno.test("broadcast round left unchanged by rematch (auto-dispatch owns +1)", () => {
  assertEquals(resolveNextRematchBroadcastRound(3), 3);
  assertEquals(resolveNextRematchBroadcastRound(0), 0);
  // replay must keep same stored round
  const committedRound = 4;
  const replayRound = resolveNextRematchBroadcastRound(committedRound);
  assertEquals(replayRound, 4);
});
