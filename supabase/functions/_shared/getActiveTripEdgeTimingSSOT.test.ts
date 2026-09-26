import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  attachGetActiveTripTiming,
  createGetActiveTripEdgeTiming,
  isGetActiveTripKnownTripIdShape,
  parseGetActiveTripPurpose,
} from "./getActiveTripEdgeTimingSSOT.ts";

Deno.test("getActiveTrip timing stamps purpose and skipped enrich", () => {
  const t = createGetActiveTripEdgeTiming(Date.now() - 40);
  t.markAuthStart();
  t.markAuthEnd();
  t.setPurpose("waiting_fare");
  t.setKnownTripId(true);
  t.setKnownTripHit(true);
  t.setSkippedFullEnrich(true);
  t.markResponseStart();
  const flat = t.toFlatFields();
  assertEquals(flat.gat_purpose, "waiting_fare");
  assertEquals(flat.gat_skipped_full_enrich, true);
  assertEquals(flat.gat_known_trip_hit, true);
  const body = attachGetActiveTripTiming({ activeTrip: null }, t);
  assertEquals(body.activeTrip, null);
  assertEquals(body.gat_purpose, "waiting_fare");
});

Deno.test("purpose parse and uuid shape", () => {
  assertEquals(parseGetActiveTripPurpose("waiting_fare"), "waiting_fare");
  assertEquals(parseGetActiveTripPurpose("waiting"), "waiting_fare");
  assertEquals(parseGetActiveTripPurpose("full"), "full");
  assertEquals(parseGetActiveTripPurpose(null), "full");
  assertEquals(isGetActiveTripKnownTripIdShape("nope"), false);
  assertEquals(
    isGetActiveTripKnownTripIdShape("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
    true,
  );
});
