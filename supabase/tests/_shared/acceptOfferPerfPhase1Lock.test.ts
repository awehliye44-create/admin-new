/**
 * Lock: Accept-offer Phase 1 — instrumented waterfall + safe post-canonical off-path.
 *
 * Canonical assignment = accept_ride_offer / accept_stacked_ride RPC success.
 * After that boundary: minimal Driver response; notify / delivery / RIDE_STOP via waitUntil.
 * Notifications are NOT removed.
 *
 * Run: deno test --allow-read supabase/tests/_shared/acceptOfferPerfPhase1Lock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildMinimalAcceptedTripSeed,
  deriveAcceptOfferEdgeDurations,
} from "../../functions/_shared/acceptOfferPerf.ts";

const acceptOfferPath = new URL(
  "../../functions/accept-offer/index.ts",
  import.meta.url,
);
const ingestPath = new URL(
  "../../functions/ingest-telemetry/index.ts",
  import.meta.url,
);
const perfHelperPath = new URL(
  "../../functions/_shared/acceptOfferPerf.ts",
  import.meta.url,
);

Deno.test("deriveAcceptOfferEdgeDurations does not double-count nested stages", () => {
  const stages = {
    edge_receive: 0,
    auth_start: 10,
    auth_end: 200,
    offer_lookup_start: 210,
    offer_lookup_end: 400,
    eligibility_validation_start: 200,
    eligibility_validation_end: 350,
    accept_rpc_start: 500,
    accept_rpc_end: 1400,
    CANONICAL_ASSIGNMENT_CONFIRMED: 1400,
    response_build_start: 1405,
    response_build_end: 1410,
    edge_response: 1415,
  };
  const d = deriveAcceptOfferEdgeDurations(stages);
  assertEquals(d.edge_auth_ms, 190);
  assertEquals(d.edge_offer_lookup_ms, 190);
  assertEquals(d.edge_accept_rpc_ms, 900);
  assertEquals(d.edge_canonical_assignment_ms, 900);
  assertEquals(d.edge_post_canonical_blocking_ms, 15);
  assertEquals(d.edge_total_ms, 1415);
  assertEquals(d.edge_post_trip_fetch_ms, null);
  assertEquals(d.edge_post_driver_fetch_ms, null);
});

Deno.test("buildMinimalAcceptedTripSeed uses RPC fields only — never fabricates assignment", () => {
  const seed = buildMinimalAcceptedTripSeed({
    tripId: "trip-1",
    driverId: "driver-1",
    rpc: {
      success: true,
      status: "driver_assigned",
      driver_net_pence: 1200,
      fare_source: "listed",
    },
  });
  assertEquals(seed.id, "trip-1");
  assertEquals(seed.status, "driver_assigned");
  assertEquals(seed.driver_id, "driver-1");
  assertEquals(seed.confirmed_driver_id, "driver-1");
  assertEquals(seed.driver_net_pence, 1200);
  assertEquals("passenger_name" in seed, false);
});

Deno.test("accept-offer marks CANONICAL_ASSIGNMENT_CONFIRMED after accept_ride_offer success", async () => {
  const src = await Deno.readTextFile(acceptOfferPath);
  const rpcIdx = src.indexOf('supabase.rpc("accept_ride_offer"');
  assertEquals(rpcIdx > 0, true);
  const afterRpc = src.slice(rpcIdx);
  assertStringIncludes(afterRpc, 'perf.mark("accept_rpc_end")');
  assertStringIncludes(afterRpc, 'perf.mark("CANONICAL_ASSIGNMENT_CONFIRMED")');
  assertStringIncludes(src, 'perf.mark("accept_rpc_start")');
});

Deno.test("accept-offer does not await full trips/drivers enrichment after canonical accept", async () => {
  const src = await Deno.readTextFile(acceptOfferPath);
  assertStringIncludes(src, "buildMinimalAcceptedTripSeed");
  const afterCanonical = src.slice(
    src.lastIndexOf('perf.mark("CANONICAL_ASSIGNMENT_CONFIRMED")'),
  );
  assertEquals(
    afterCanonical.includes('.select("first_name, last_name, phone'),
    false,
  );
  assertEquals(afterCanonical.includes('.select("*")'), false);
  assertStringIncludes(src, "scheduleAcceptOfferBackground");
  const helper = await Deno.readTextFile(perfHelperPath);
  assertStringIncludes(helper, "EdgeRuntime.waitUntil");
});

Deno.test("accept-offer still generates customer driver_assigned + RIDE_STOP + booking delivery", async () => {
  const src = await Deno.readTextFile(acceptOfferPath);
  assertStringIncludes(src, 'event: "driver_assigned"');
  assertStringIncludes(src, "notifyCustomerTripLifecycle");
  assertStringIncludes(src, "sendRideStopPush");
  assertStringIncludes(src, 'type: "RIDE_STOP"');
  assertStringIncludes(src, "record_booking_delivery");
  assertStringIncludes(src, 'p_phase: "accepted"');
  const bgIdx = src.indexOf("scheduleAcceptOfferBackground(async () => {");
  assertEquals(bgIdx > 0, true);
  const bgBlock = src.slice(bgIdx, bgIdx + 3500);
  assertStringIncludes(bgBlock, "notifyCustomerTripLifecycle");
  assertStringIncludes(bgBlock, "sendRideStopPush");
  assertStringIncludes(bgBlock, "record_booking_delivery");
});

Deno.test("accept-offer still calls accept_ride_offer / accept_stacked_ride (atomicity preserved)", async () => {
  const src = await Deno.readTextFile(acceptOfferPath);
  assertStringIncludes(src, 'supabase.rpc("accept_ride_offer"');
  assertStringIncludes(src, '"accept_stacked_ride"');
  assertStringIncludes(src, "assertCanAcceptOfferByDriverId");
  assertStringIncludes(src, "requireAuthenticatedUser");
});

Deno.test("accept-offer preserves eligibility / negotiation / stacked / scheduled guards", async () => {
  const src = await Deno.readTextFile(acceptOfferPath);
  assertStringIncludes(src, "BLOCKED_NEGOTIATION_HELD");
  assertStringIncludes(src, "ACTIVE_TRIP_REQUIRES_STACKED_ACCEPT");
  assertStringIncludes(src, "NEGOTIATION_PENDING_CUSTOMER");
  assertStringIncludes(src, "is_urgent_dispatch");
  assertStringIncludes(src, "scheduled_status");
  assertStringIncludes(src, "STACKED_RIDE_AUTO_REDIRECT");
});

Deno.test("accept-offer returns lifecycle_perf_stages_ms + derived edge durations", async () => {
  const src = await Deno.readTextFile(acceptOfferPath);
  assertStringIncludes(src, "lifecycle_perf_stages_ms");
  assertStringIncludes(src, "stageDurations");
  assertStringIncludes(src, "perf.durations()");
  assertStringIncludes(src, "perf_id");
  const helper = await Deno.readTextFile(perfHelperPath);
  assertStringIncludes(helper, "edge_accept_rpc_ms");
  assertStringIncludes(helper, "edge_post_canonical_blocking_ms");
});

Deno.test("ingest-telemetry allows Accept waterfall flat metadata keys", async () => {
  const src = await Deno.readTextFile(ingestPath);
  assertStringIncludes(src, '"accept_tap_to_interactive_ms"');
  assertStringIncludes(src, '"accept_edge_rtt_ms"');
  assertStringIncludes(src, '"edge_accept_rpc_ms"');
  assertStringIncludes(src, '"perf_id"');
});

Deno.test("acceptOfferPerf helper exposes waitUntil scheduling", async () => {
  const src = await Deno.readTextFile(perfHelperPath);
  assertStringIncludes(src, "EdgeRuntime.waitUntil");
  assertStringIncludes(src, "scheduleAcceptOfferBackground");
  assertStringIncludes(src, "buildMinimalAcceptedTripSeed");
});
