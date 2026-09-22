import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  appendIntermediateStops,
  rebuildItineraryStops,
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

Deno.test("LOCK: add_stop rebuild inserts before dropoff (MK-260922-001)", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/request-trip-modification/index.ts", import.meta.url),
  );
  if (!src.includes("appendIntermediateStops")) {
    throw new Error("request-trip-modification must use appendIntermediateStops for add_stop");
  }
  if (!src.includes("rebuildItineraryStops")) {
    throw new Error("request-trip-modification must rebuild itinerary contiguously");
  }
  if (src.includes("maxIndex + index + 1")) {
    throw new Error("add_stop must not append after maxIndex (places stop after dropoff)");
  }
});
