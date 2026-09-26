import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  attachRestoreTiming,
  createRestoreEdgeTiming,
} from "./restoreEdgeTimingSSOT.ts";
import { isRestoreKnownTripIdShape } from "./activeTripRestoreCore.ts";

Deno.test("restoreEdgeTiming flat fields include total and known-trip flags", () => {
  const t = createRestoreEdgeTiming(Date.now() - 50);
  t.markAuthStart();
  t.markAuthEnd();
  t.setKnownTripId(true);
  t.setKnownTripHit(true);
  t.setTrigger("lifecycle");
  t.markResponseStart();
  const flat = t.toFlatFields();
  assertEquals(typeof flat.restore_edge_total_ms, "number");
  assertEquals(flat.restore_known_trip_id, true);
  assertEquals(flat.restore_known_trip_hit, true);
  assertEquals(flat.restore_trigger, "lifecycle");
  const body = attachRestoreTiming({ has_active_trip: false }, t);
  assertEquals(body.has_active_trip, false);
  assertEquals(body.restore_known_trip_id, true);
});

Deno.test("known trip id shape rejects non-uuid", () => {
  assertEquals(isRestoreKnownTripIdShape("not-a-uuid"), false);
  assertEquals(isRestoreKnownTripIdShape(""), false);
  assertEquals(isRestoreKnownTripIdShape(null), false);
  assertEquals(
    isRestoreKnownTripIdShape("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
    true,
  );
});
