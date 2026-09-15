/**
 * A1 lock: driver pre-start cancel → rematch.
 * Retired-column SELECT, schema classify, same trip id, exclude cancelling driver,
 * searching_new_driver, hold untouched, before Start Trip only, idempotent replay.
 *
 * Free-wait fee/capture tests live in A2 — not imported here.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyTripLookupFailure,
  isIdempotentDriverRematchReplay,
  isPrePickupDriverRematchEligibleDbStatus,
  TRIP_CANCEL_REMATCH_SELECT,
} from "./driverCancelRematch.ts";

const TRIP_ID = "c7ce4f1a-897a-41f0-8d26-2ec9df72a062";
const DRIVER_ID = "c40dd8a6-f422-40bc-9534-bae7be88b93e";

/** Internal rematch simulator — no payment dispose / capture. */
function simulateDriverRematch(args: {
  tripId: string;
  status: string;
  driverId: string;
  cancelledDriverIds: string[];
  excludedDriverIds: string[];
  holdPence: number;
}) {
  if (isIdempotentDriverRematchReplay(args)) {
    return {
      allowed: true,
      idempotent: true,
      tripId: args.tripId,
      status: "searching_new_driver",
      cancelledDriverIds: args.cancelledDriverIds,
      excludedDriverIds: args.excludedDriverIds,
      exclusionWrites: 0,
      offerWrites: 0,
      holdPence: args.holdPence,
      capturePence: 0,
      refundPence: 0,
      walletPence: 0,
    };
  }
  if (!isPrePickupDriverRematchEligibleDbStatus(args.status)) {
    return {
      allowed: false,
      error: "INVALID_STATE",
      tripId: args.tripId,
      holdPence: args.holdPence,
      capturePence: 0,
      refundPence: 0,
      walletPence: 0,
    };
  }
  const cancelled = args.cancelledDriverIds.includes(args.driverId)
    ? args.cancelledDriverIds
    : [...args.cancelledDriverIds, args.driverId];
  const excluded = [...new Set([...args.excludedDriverIds, args.driverId])];
  return {
    allowed: true,
    idempotent: false,
    tripId: args.tripId,
    status: "searching_new_driver",
    cancelledDriverIds: cancelled,
    excludedDriverIds: excluded,
    exclusionWrites: 1,
    offerWrites: 1,
    holdPence: args.holdPence,
    capturePence: 0,
    refundPence: 0,
    walletPence: 0,
  };
}

Deno.test("A1: rematch select does not depend on retired columns", () => {
  assertEquals(TRIP_CANCEL_REMATCH_SELECT.includes("scan_go"), false);
  assertEquals(TRIP_CANCEL_REMATCH_SELECT.includes("locked_driver_id"), false);
  assertStringIncludes(TRIP_CANCEL_REMATCH_SELECT, "confirmed_driver_id");
});

Deno.test("A1: pre-pickup statuses are rematch-eligible; in_progress is not", () => {
  assertEquals(isPrePickupDriverRematchEligibleDbStatus("driver_assigned"), true);
  assertEquals(isPrePickupDriverRematchEligibleDbStatus("en_route_to_pickup"), true);
  assertEquals(isPrePickupDriverRematchEligibleDbStatus("arrived_at_pickup"), true);
  assertEquals(isPrePickupDriverRematchEligibleDbStatus("in_progress"), false);
  assertEquals(isPrePickupDriverRematchEligibleDbStatus("started"), false);
});

Deno.test("A1: duplicate cancel is idempotent replay, not a second exclusion", () => {
  assertEquals(isIdempotentDriverRematchReplay({
    status: "searching_new_driver",
    driverId: DRIVER_ID,
    cancelledDriverIds: [DRIVER_ID],
    excludedDriverIds: [DRIVER_ID],
  }), true);
  assertEquals(isIdempotentDriverRematchReplay({
    status: "arrived_at_pickup",
    driverId: DRIVER_ID,
    cancelledDriverIds: [],
    excludedDriverIds: [],
  }), false);
});

Deno.test("A1: schema select failure 42703 is not Trip not found", () => {
  const classified = classifyTripLookupFailure({
    code: "42703",
    message: "column trips.scan_go does not exist",
  });
  assertEquals(classified?.kind, "schema");
  assertEquals(classified?.error, "SCHEMA_ERROR");
  assertEquals(classified?.httpStatus, 500);
  assertEquals(classifyTripLookupFailure(null), null);
});

Deno.test("A1: rematch keeps trip id, excludes driver, leaves hold untouched", () => {
  const before = simulateDriverRematch({
    tripId: TRIP_ID,
    status: "en_route_to_pickup",
    driverId: DRIVER_ID,
    cancelledDriverIds: [],
    excludedDriverIds: [],
    holdPence: 800,
  });
  assertEquals(before.allowed, true);
  assertEquals(before.tripId, TRIP_ID);
  assertEquals(before.status, "searching_new_driver");
  assertEquals(before.excludedDriverIds.includes(DRIVER_ID), true);
  assertEquals(before.holdPence, 800);
  assertEquals(before.capturePence, 0);

  const during = simulateDriverRematch({
    tripId: TRIP_ID,
    status: "arrived_at_pickup",
    driverId: DRIVER_ID,
    cancelledDriverIds: [],
    excludedDriverIds: [],
    holdPence: 800,
  });
  assertEquals(during.tripId, TRIP_ID);
  assertEquals(during.excludedDriverIds.includes(DRIVER_ID), true);
  assertEquals(during.capturePence, 0);
  assertEquals(during.walletPence, 0);
});

Deno.test("A1: after Start Trip pre-start cancel is denied and hold is untouched", () => {
  const denied = simulateDriverRematch({
    tripId: TRIP_ID,
    status: "in_progress",
    driverId: DRIVER_ID,
    cancelledDriverIds: [],
    excludedDriverIds: [],
    holdPence: 800,
  });
  assertEquals(denied.allowed, false);
  assertEquals(denied.error, "INVALID_STATE");
  assertEquals(denied.holdPence, 800);
  assertEquals(denied.capturePence, 0);
});

Deno.test("A1: duplicate rematch writes no second exclusion or offer row", () => {
  const first = simulateDriverRematch({
    tripId: TRIP_ID,
    status: "arrived_at_pickup",
    driverId: DRIVER_ID,
    cancelledDriverIds: [],
    excludedDriverIds: [],
    holdPence: 800,
  });
  const second = simulateDriverRematch({
    tripId: TRIP_ID,
    status: first.status ?? "searching_new_driver",
    driverId: DRIVER_ID,
    cancelledDriverIds: first.cancelledDriverIds ?? [],
    excludedDriverIds: first.excludedDriverIds ?? [],
    holdPence: 800,
  });
  assertEquals(second.idempotent, true);
  assertEquals(second.exclusionWrites, 0);
  assertEquals(second.offerWrites, 0);
  assertEquals(second.cancelledDriverIds, first.cancelledDriverIds);
});

Deno.test("A1: live rematch sources do not select retired columns", async () => {
  const rematch = await Deno.readTextFile(new URL("./driverCancelRematch.ts", import.meta.url));
  const driverCancel = await Deno.readTextFile(
    new URL("../driver-cancel-before-pickup/index.ts", import.meta.url),
  );
  const resume = await Deno.readTextFile(
    new URL("../customer-resume-driver-search/index.ts", import.meta.url),
  );
  assertEquals(rematch.includes("scan_go"), false);
  assertEquals(rematch.includes("locked_driver_id"), false);
  assertEquals(/select\([^)]*scan_go/.test(rematch), false);
  assertEquals(driverCancel.includes("if (tripError || !trip)"), false);
  assertStringIncludes(driverCancel, "classifyTripLookupFailure");
  assertStringIncludes(driverCancel, 'errorResponse("NOT_FOUND", "Trip not found", 404)');
  assertEquals(resume.includes("locked_driver_id: null"), false);
  // A1 must not pull free-wait cancel-trip into this package
  assertEquals(driverCancel.includes("cancelled_after_arrival_grace"), false);
});
