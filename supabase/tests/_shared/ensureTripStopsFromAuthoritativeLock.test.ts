/**
 * Phase 1 — stop-workflow must never flatten multi-stop trips when reconstructing
 * missing trip_stops rows. Authoritative vias live on trips.stops.
 *
 * Run:
 *   deno test --allow-read supabase/functions/_shared/ensureTripStopsFromAuthoritativeLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  authoritativeTotalStops,
  buildAuthoritativeTripStopRows,
  needsTripStopsReconstruction,
  parseAuthoritativeViaStops,
  tripStopsSequenceFingerprint,
} from "../../functions/_shared/ensureTripStopsFromAuthoritative.ts";

const TRIP_ID = "11111111-1111-1111-1111-111111111111";

const baseTrip = {
  id: TRIP_ID,
  pickup_address: "Pickup Road",
  pickup_latitude: 52.0,
  pickup_longitude: -0.7,
  dropoff_address: "Final Destination",
  dropoff_latitude: 52.1,
  dropoff_longitude: -0.8,
};

Deno.test("1. zero intermediate stops → normal single trip (pickup + dropoff)", () => {
  const rows = buildAuthoritativeTripStopRows({ ...baseTrip, stops: [] });
  assertEquals(rows.map((r) => r.type), ["pickup", "dropoff"]);
  assertEquals(rows.map((r) => r.stop_index), [0, 1]);
  assertEquals(authoritativeTotalStops([]), 2);
  assertEquals(needsTripStopsReconstruction({ existingRows: [], stopsJson: [] }), true);
  assertEquals(
    needsTripStopsReconstruction({
      existingRows: [
        { type: "pickup", stop_index: 0 },
        { type: "dropoff", stop_index: 1 },
      ],
      stopsJson: [],
    }),
    false,
  );
});

Deno.test("2. one intermediate stop → preserved between pickup and dropoff", () => {
  const vias = [{ address: "Stop 1 Cafe", lat: 52.05, lng: -0.75 }];
  const rows = buildAuthoritativeTripStopRows({ ...baseTrip, stops: vias });
  assertEquals(rows.map((r) => r.type), ["pickup", "stop", "dropoff"]);
  assertEquals(rows.map((r) => r.stop_index), [0, 1, 2]);
  assertEquals(rows[1].address, "Stop 1 Cafe");
  assertEquals(rows[2].address, "Final Destination");
  assertEquals(authoritativeTotalStops(vias), 3);
});

Deno.test("3. multiple intermediate stops → preserved in exact order", () => {
  const vias = [
    { address: "Via A", lat: 52.01, lng: -0.71 },
    { address: "Via B", lat: 52.02, lng: -0.72 },
    { address: "Via C", lat: 52.03, lng: -0.73 },
  ];
  const rows = buildAuthoritativeTripStopRows({ ...baseTrip, stops: vias });
  assertEquals(rows.map((r) => r.type), ["pickup", "stop", "stop", "stop", "dropoff"]);
  assertEquals(rows.map((r) => r.address), [
    "Pickup Road",
    "Via A",
    "Via B",
    "Via C",
    "Final Destination",
  ]);
  assertEquals(rows.map((r) => r.stop_index), [0, 1, 2, 3, 4]);
  assertEquals(parseAuthoritativeViaStops(vias).map((v) => v.address), [
    "Via A",
    "Via B",
    "Via C",
  ]);
});

Deno.test("4. empty workflow initialization → vias preserved (never pickup→dropoff only)", () => {
  const vias = [
    { address: "Westcroft", lat: 52.005, lng: -0.792 },
    { address: "CMK", lat: 52.04, lng: -0.76 },
  ];
  assertEquals(
    needsTripStopsReconstruction({ existingRows: [], stopsJson: vias }),
    true,
  );
  const rows = buildAuthoritativeTripStopRows({ ...baseTrip, stops: vias });
  assertEquals(rows.length, 4);
  assertEquals(rows.some((r) => r.type === "stop"), true);
  assertEquals(rows.filter((r) => r.type === "stop").map((r) => r.address), [
    "Westcroft",
    "CMK",
  ]);
});

Deno.test("5. restore/retry → no duplicate stop sequence (same fingerprint)", () => {
  const vias = [
    { address: "A", lat: 1, lng: 2 },
    { address: "B", lat: 3, lng: 4 },
  ];
  const first = buildAuthoritativeTripStopRows({ ...baseTrip, stops: vias });
  const second = buildAuthoritativeTripStopRows({ ...baseTrip, stops: vias });
  assertEquals(
    tripStopsSequenceFingerprint(first),
    tripStopsSequenceFingerprint(second),
  );
  assertEquals(first.length, second.length);
});

Deno.test("6. repeated initialization gate is idempotent once intermediates exist", () => {
  const vias = [{ address: "Stop 1", lat: 52.01, lng: -0.71 }];
  const seeded = buildAuthoritativeTripStopRows({ ...baseTrip, stops: vias });
  assertEquals(
    needsTripStopsReconstruction({ existingRows: seeded, stopsJson: vias }),
    false,
  );
  // Flattened pickup+dropoff while vias remain on trip → still needs repair
  assertEquals(
    needsTripStopsReconstruction({
      existingRows: [
        { type: "pickup", stop_index: 0 },
        { type: "dropoff", stop_index: 1 },
      ],
      stopsJson: vias,
    }),
    true,
  );
});

Deno.test("7. current-leg index is not rewritten by reconstruction payload", () => {
  const vias = [
    { address: "Stop 1", lat: 52.01, lng: -0.71 },
    { address: "Stop 2", lat: 52.02, lng: -0.72 },
  ];
  const trip = {
    ...baseTrip,
    stops: vias,
    current_stop_index: 2,
    total_stops: 4,
  };
  const rows = buildAuthoritativeTripStopRows(trip);
  // Reconstruction only seeds rows — does not clamp or invent a new current index.
  assertEquals(trip.current_stop_index, 2);
  assertEquals(rows[0].stop_index, 0);
  assertEquals(rows.find((r) => r.type === "dropoff")?.stop_index, 3);
});

Deno.test("stop-workflow uses ensure RPC + authoritative helper; no pickup+dropoff-only auto-create", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/stop-workflow/index.ts", import.meta.url),
  );
  assertEquals(
    src.includes('from "../_shared/ensureTripStopsFromAuthoritative.ts"'),
    true,
  );
  assertEquals(src.includes("ensure_trip_stops_for_assignment"), true);
  assertEquals(src.includes("needsTripStopsReconstruction"), true);
  assertEquals(src.includes("buildAuthoritativeTripStopRows"), true);
  // Legacy flatten payload must not remain.
  assertEquals(src.includes("No stops found, auto-creating from trip data"), false);
  assertEquals(
    /stopsToCreate\s*=\s*\[[\s\S]*?type:\s*'pickup'[\s\S]*?type:\s*'dropoff'[\s\S]*?\]/.test(
      src,
    ),
    false,
  );
});
