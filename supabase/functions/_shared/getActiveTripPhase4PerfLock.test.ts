/**
 * LOCK — get-active-trip Phase 4: waiting_fare minimal path + known-trip
 * ownership fast path; skip full enrich (service-area/Revolut/communication/
 * photo/route) on waiting ticks; stage telemetry non-blocking.
 *
 * Does NOT weaken: waiting money SSOT, ownership, radius/stop identity,
 * restore Phase 3, create-preauth Phase 2, Hang patch.
 */
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const indexSrc = await Deno.readTextFile(
  new URL("../get-active-trip/index.ts", import.meta.url),
);
const timingSrc = await Deno.readTextFile(
  new URL("./getActiveTripEdgeTimingSSOT.ts", import.meta.url),
);

Deno.test("waiting_fare purpose skips full enrich and Revolut service-area secrets", () => {
  assertStringIncludes(indexSrc, 'purpose === "waiting_fare"');
  assertStringIncludes(indexSrc, "setSkippedFullEnrich(true)");
  assertStringIncludes(indexSrc, "loadAdminWaitingConfig");
  // waiting path must not call buildServiceAreaConfigPayload
  const waitingIdx = indexSrc.indexOf('purpose === "waiting_fare"');
  const fullIdx = indexSrc.indexOf("FULL PATH");
  const waitingSlice = indexSrc.slice(waitingIdx, fullIdx > waitingIdx ? fullIdx : waitingIdx + 3500);
  if (waitingSlice.includes("buildServiceAreaConfigPayload")) {
    throw new Error("waiting_fare path must not call buildServiceAreaConfigPayload");
  }
  if (waitingSlice.includes("buildTripCommunicationConfigForTrip")) {
    throw new Error("waiting_fare path must not call communication config");
  }
  if (waitingSlice.includes("createSignedUrl")) {
    throw new Error("waiting_fare path must not sign driver photos");
  }
});

Deno.test("known trip_id ownership-verified before trust", () => {
  assertStringIncludes(indexSrc, "isGetActiveTripKnownTripIdShape");
  assertStringIncludes(indexSrc, "never trust client trip_id without ownership verification");
  assertStringIncludes(indexSrc, "passenger_id");
  assertStringIncludes(indexSrc, "tryOwnedCandidate");
});

Deno.test("waiting ticks skip expire+hold release on pointer miss path when purpose waiting", () => {
  assertStringIncludes(indexSrc, 'purpose === "full"');
  assertStringIncludes(indexSrc, "expireTripWhenSearchExhaustedAndNotifyCustomer");
  // Call site (not import) must be gated by purpose === "full".
  const callIdx = indexSrc.indexOf("await expireTripWhenSearchExhaustedAndNotifyCustomer");
  if (callIdx < 0) throw new Error("expire call site missing");
  const before = indexSrc.slice(Math.max(0, callIdx - 500), callIdx);
  assertStringIncludes(before, 'purpose === "full"');
});

Deno.test("full path parallelizes stops/mods/route and driver/region/comm", () => {
  assertStringIncludes(indexSrc, "Promise.all([");
  assertStringIncludes(indexSrc, "trip_route_cache");
  assertStringIncludes(indexSrc, "trip_change_requests");
  assertStringIncludes(indexSrc, "buildServiceAreaConfigPayload");
});

Deno.test("Phase-4 timing field names present", () => {
  for (const k of [
    "gat_auth_ms",
    "gat_identity_ms",
    "gat_trip_ms",
    "gat_stops_ms",
    "gat_waiting_ms",
    "gat_edge_total_ms",
    "gat_known_trip_id",
    "gat_purpose",
    "gat_skipped_full_enrich",
  ]) {
    assertStringIncludes(timingSrc, k);
  }
  assertStringIncludes(indexSrc, "attachGetActiveTripTiming");
});
