import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  appendIntermediateStops,
  assertFinalDropoffRequired,
  rebuildItineraryStops,
  rebuildRemainingRouteItinerary,
  removeIntermediateStop,
} from "../../functions/_shared/tripModificationItinerary.ts";

Deno.test("rebuildItineraryStops always places intermediates before dropoff", () => {
  const stops = rebuildItineraryStops({
    pickup: { address: "A", lat: 1, lng: 1, type: "pickup", status: "pending" },
    intermediates: [
      { address: "B", lat: 2, lng: 2, type: "stop", status: "pending" },
      { address: "C", lat: 3, lng: 3, type: "stop", status: "pending" },
    ],
    dropoff: { address: "D", lat: 4, lng: 4 },
  });
  assertEquals(
    stops.map((s) => ({ type: s.type, index: s.stop_index, address: s.address })),
    [
      { type: "pickup", index: 0, address: "A" },
      { type: "stop", index: 1, address: "B" },
      { type: "stop", index: 2, address: "C" },
      { type: "dropoff", index: 3, address: "D" },
    ],
  );
});

Deno.test("appendIntermediateStops does not leave new stop after dropoff (MK-260922-001)", () => {
  const before = [
    {
      address: "Pickup",
      lat: 51.99,
      lng: -0.8,
      type: "pickup",
      status: "pending",
      stop_index: 0,
    },
    {
      address: "Work",
      lat: 52.0,
      lng: -0.79,
      type: "dropoff",
      status: "pending",
      stop_index: 1,
    },
  ];
  const after = appendIntermediateStops({
    stops: before,
    pickupFallback: { address: "Pickup", lat: 51.99, lng: -0.8 },
    dropoffFallback: { address: "Work", lat: 52.0, lng: -0.79 },
    toAdd: [{ address: "Home", lat: 51.99, lng: -0.8, type: "stop", status: "pending" }],
  });
  assertEquals(
    after.map((s) => ({ type: s.type, index: s.stop_index, address: s.address })),
    [
      { type: "pickup", index: 0, address: "Pickup" },
      { type: "stop", index: 1, address: "Home" },
      { type: "dropoff", index: 2, address: "Work" },
    ],
  );
});

Deno.test("removeIntermediateStop reindexes dropoff contiguously", () => {
  const before = [
    {
      address: "Pickup",
      lat: 1,
      lng: 1,
      type: "pickup",
      status: "pending",
      stop_index: 0,
    },
    {
      address: "Home",
      lat: 2,
      lng: 2,
      type: "stop",
      status: "pending",
      stop_index: 1,
    },
    {
      address: "Work",
      lat: 3,
      lng: 3,
      type: "dropoff",
      status: "pending",
      stop_index: 2,
    },
  ];
  const result = removeIntermediateStop({
    stops: before,
    stopIndexToRemove: 1,
    pickupFallback: { address: "Pickup", lat: 1, lng: 1 },
    dropoffFallback: { address: "Work", lat: 3, lng: 3 },
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.stops.map((s) => ({ type: s.type, index: s.stop_index, address: s.address })),
    [
      { type: "pickup", index: 0, address: "Pickup" },
      { type: "dropoff", index: 1, address: "Work" },
    ],
  );
});

Deno.test("assertFinalDropoffRequired rejects missing / trailing-stop itineraries", () => {
  const missing = assertFinalDropoffRequired({
    dropoff: { address: "", lat: null, lng: null },
    stops: [
      { address: "A", lat: 1, lng: 1, type: "pickup", stop_index: 0 },
      { address: "B", lat: 2, lng: 2, type: "stop", stop_index: 1 },
    ],
  });
  assertEquals(missing.ok, false);
  if (missing.ok) return;
  assertEquals(missing.code, "DROPOFF_REQUIRED");

  const trailingStop = assertFinalDropoffRequired({
    dropoff: { address: "Work", lat: 3, lng: 3 },
    stops: [
      { address: "A", lat: 1, lng: 1, type: "pickup", stop_index: 0 },
      { address: "B", lat: 2, lng: 2, type: "stop", stop_index: 1 },
    ],
  });
  assertEquals(trailingStop.ok, false);

  const ok = assertFinalDropoffRequired({
    dropoff: { address: "Work", lat: 3, lng: 3 },
    stops: [
      { address: "A", lat: 1, lng: 1, type: "pickup", stop_index: 0 },
      { address: "B", lat: 2, lng: 2, type: "stop", stop_index: 1 },
      { address: "Work", lat: 3, lng: 3, type: "dropoff", stop_index: 2 },
    ],
  });
  assertEquals(ok.ok, true);
});

Deno.test("rebuildRemainingRouteItinerary keeps past stops; only future + dropoff change", () => {
  const before = [
    {
      address: "Pickup",
      lat: 1,
      lng: 1,
      type: "pickup",
      status: "completed",
      stop_index: 0,
    },
    {
      address: "Past Shop",
      lat: 2,
      lng: 2,
      type: "stop",
      status: "completed",
      stop_index: 1,
    },
    {
      address: "Future Cafe",
      lat: 3,
      lng: 3,
      type: "stop",
      status: "pending",
      stop_index: 2,
    },
    {
      address: "Old Drop",
      lat: 4,
      lng: 4,
      type: "dropoff",
      status: "pending",
      stop_index: 3,
    },
  ];
  const after = rebuildRemainingRouteItinerary({
    beforeStops: before,
    futureIntermediates: [
      { address: "New Stop", lat: 5, lng: 5, type: "stop", status: "pending" },
    ],
    dropoff: { address: "New Drop", lat: 6, lng: 6 },
    tripStatus: "in_progress",
  });
  assertEquals(
    after.map((s) => ({ type: s.type, index: s.stop_index, address: s.address, status: s.status })),
    [
      { type: "pickup", index: 0, address: "Pickup", status: "completed" },
      { type: "stop", index: 1, address: "Past Shop", status: "completed" },
      { type: "stop", index: 2, address: "New Stop", status: "pending" },
      { type: "dropoff", index: 3, address: "New Drop", status: "pending" },
    ],
  );
});

Deno.test("removeIntermediateStop rejects past / locked stops", () => {
  const before = [
    {
      address: "Pickup",
      lat: 1,
      lng: 1,
      type: "pickup",
      status: "completed",
      stop_index: 0,
    },
    {
      address: "Past",
      lat: 2,
      lng: 2,
      type: "stop",
      status: "completed",
      stop_index: 1,
    },
    {
      address: "Future",
      lat: 3,
      lng: 3,
      type: "stop",
      status: "pending",
      stop_index: 2,
    },
    {
      address: "Drop",
      lat: 4,
      lng: 4,
      type: "dropoff",
      status: "pending",
      stop_index: 3,
    },
  ];
  const locked = removeIntermediateStop({
    stops: before,
    stopIndexToRemove: 1,
    pickupFallback: { address: "Pickup", lat: 1, lng: 1 },
    dropoffFallback: { address: "Drop", lat: 4, lng: 4 },
    tripStatus: "in_progress",
  });
  assertEquals(locked.ok, false);
  if (!locked.ok) assertEquals(locked.reason, "locked");

  const ok = removeIntermediateStop({
    stops: before,
    stopIndexToRemove: 2,
    pickupFallback: { address: "Pickup", lat: 1, lng: 1 },
    dropoffFallback: { address: "Drop", lat: 4, lng: 4 },
    tripStatus: "in_progress",
  });
  assertEquals(ok.ok, true);
});

Deno.test("LOCK: request-trip-modification rebuilds remaining route only", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/request-trip-modification/index.ts", import.meta.url),
  );
  if (!src.includes("rebuildRemainingRouteItinerary")) {
    throw new Error("request-trip-modification must use rebuildRemainingRouteItinerary");
  }
  if (!src.includes("filterFutureIntermediatesOnly")) {
    throw new Error("request-trip-modification must strip past stops from client newStops");
  }
  if (!src.includes("isPastIntermediateStop")) {
    throw new Error("request-trip-modification must gate on isPastIntermediateStop");
  }
});

Deno.test("LOCK: request-trip-modification rejects missing dropoff with DROPOFF_REQUIRED", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/request-trip-modification/index.ts", import.meta.url),
  );
  if (!src.includes("assertFinalDropoffRequired")) {
    throw new Error("request-trip-modification must gate final dropoff");
  }
  if (!src.includes("DROPOFF_REQUIRED")) {
    throw new Error("request-trip-modification must return DROPOFF_REQUIRED");
  }
  if (!src.includes("Final drop-off is required. Please choose a destination.")) {
    throw new Error("request-trip-modification must use customer dropoff-required copy");
  }
});

Deno.test("LOCK: add_stop rebuild inserts before dropoff (MK-260922-001)", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/request-trip-modification/index.ts", import.meta.url),
  );
  if (!src.includes("appendIntermediateStops")) {
    throw new Error("request-trip-modification must use appendIntermediateStops for add_stop");
  }
  if (!src.includes("rebuildRemainingRouteItinerary")) {
    throw new Error("request-trip-modification must rebuild remaining route contiguously");
  }
  if (src.includes("maxIndex + index + 1")) {
    throw new Error("add_stop must not append after maxIndex (places stop after dropoff)");
  }
});
