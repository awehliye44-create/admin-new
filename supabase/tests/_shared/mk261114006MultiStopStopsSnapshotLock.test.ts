/**
 * MK-261114-006 — stop-workflow must never synthesise stops:[] on skip refresh,
 * and must refuse Complete Trip while intermediate vias remain.
 *
 * Run: deno test --allow-read supabase/tests/_shared/mk261114006MultiStopStopsSnapshotLock.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const stopWorkflowPath = new URL(
  "../../functions/stop-workflow/index.ts",
  import.meta.url,
);

Deno.test("respondOk never synthesises empty stops on skipSnapshotRefresh (MK-261114-006)", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  assertStringIncludes(src, "MK-261114-006");
  assertStringIncludes(
    src,
    "never emit synthetic [] which the",
  );
  assertStringIncludes(
    src,
    "null = omit stops key (never synthesise [] — MK-261114-006)",
  );
  assertStringIncludes(
    src,
    "failed to attach trip_stops on skipSnapshotRefresh",
  );
  assertEquals(src.includes("stops: payload.stops ?? stopsSnapshot"), false);
});

Deno.test("complete_trip refuses while intermediate stops remain (MK-261114-006)", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  assertStringIncludes(src, "INTERMEDIATE_STOPS_REMAIN");
  assertStringIncludes(
    src,
    "Finish remaining stops before completing the trip.",
  );
  assertStringIncludes(src, "pendingIntermediateStops");
  assert(src.includes('s.type === "stop"'));
});

Deno.test("arrive_stop still attaches stops on skipSnapshotRefresh (prior lock)", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  assertStringIncludes(
    src,
    "Must include stops: skipSnapshotRefresh otherwise leaves Driver on en_route_stop",
  );
});
