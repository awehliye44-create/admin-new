/**
 * LOCK — restore-active-trip Phase 3: known-trip-id fast path with ownership
 * verification; parallel enrich; role:"customer" skips driver∩customer probe;
 * stage telemetry non-blocking.
 *
 * Does NOT weaken: ownership, lifecycle SSOT, stops, scheduled/stacked,
 * payment fields, Hang patch, create-preauth Phase 2.
 */
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const indexSrc = await Deno.readTextFile(
  new URL("../restore-active-trip/index.ts", import.meta.url),
);
const coreSrc = await Deno.readTextFile(
  new URL("./activeTripRestoreCore.ts", import.meta.url),
);
const timingSrc = await Deno.readTextFile(
  new URL("./restoreEdgeTimingSSOT.ts", import.meta.url),
);

Deno.test("known trip_id accepted but ownership-verified in core", () => {
  assertStringIncludes(coreSrc, "knownTripId");
  assertStringIncludes(coreSrc, "passenger_id");
  assertStringIncludes(coreSrc, "never trust client trip_id without ownership verification");
  assertStringIncludes(coreSrc, "isRestoreKnownTripIdShape");
  assertStringIncludes(indexSrc, "findCustomerActiveTripDetailed");
  assertStringIncludes(indexSrc, "trip_id");
});

Deno.test("customer role skips dual drivers+customers probe when body.role set", () => {
  assertStringIncludes(indexSrc, 'body.role ?? "customer"');
  assertStringIncludes(indexSrc, "if (!body.role)");
  // Probe only inside !body.role branch.
  const probeIdx = indexSrc.indexOf('if (!body.role)');
  const after = indexSrc.slice(probeIdx, probeIdx + 500);
  assertStringIncludes(after, '.from("drivers")');
  assertStringIncludes(after, '.from("customers")');
});

Deno.test("enrich parallelized with communication and negotiation", () => {
  assertStringIncludes(indexSrc, "Promise.all([");
  assertStringIncludes(indexSrc, "buildRestoreActiveTripPayload");
  assertStringIncludes(indexSrc, "buildTripCommunicationConfigForTrip");
  assertStringIncludes(coreSrc, "Promise.all([");
  assertStringIncludes(coreSrc, "loadAdminWaitingConfig");
  assertStringIncludes(coreSrc, "buildCustomerSafeAssignedDriver");
});

Deno.test("broad search instant || scheduled parallelized on miss", () => {
  assertStringIncludes(coreSrc, "Instant ∥ scheduled broad search");
  const miss = coreSrc.indexOf("Instant ∥ scheduled broad search");
  const slice = coreSrc.slice(miss, miss + 600);
  assertStringIncludes(slice, "Promise.all([");
});

Deno.test("Phase-3 timing field names present", () => {
  for (const k of [
    "restore_auth_ms",
    "restore_identity_ms",
    "restore_trip_ms",
    "restore_stops_ms",
    "restore_driver_ms",
    "restore_waiting_ms",
    "restore_secondary_ms",
    "restore_response_ms",
    "restore_edge_total_ms",
    "restore_known_trip_id",
  ]) {
    assertStringIncludes(timingSrc, k);
  }
  assertStringIncludes(indexSrc, "attachRestoreTiming");
  assertStringIncludes(timingSrc, "attachRestoreTiming");
});

Deno.test("attachRestoreTiming never throws into response path", () => {
  assertStringIncludes(timingSrc, "catch");
  assertStringIncludes(timingSrc, "Safe attach");
});
