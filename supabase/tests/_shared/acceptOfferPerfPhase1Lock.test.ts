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
    post_assignment_trip_fetch_start: 1400,
    post_assignment_trip_fetch_end: 1400,
    post_assignment_driver_fetch_start: 1400,
    post_assignment_driver_fetch_end: 1400,
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
  assertEquals(d.edge_post_trip_fetch_ms, 0);
  assertEquals(d.edge_post_driver_fetch_ms, 0);
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
  assertStringIncludes(helper, "scheduleEdgeBackground");
  const bg = await Deno.readTextFile(
    new URL("../../functions/_shared/scheduleEdgeBackground.ts", import.meta.url),
  );
  assertStringIncludes(bg, "EdgeRuntime.waitUntil");
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
  const bgBlock = src.slice(bgIdx, bgIdx + 8000);
  assertStringIncludes(bgBlock, "notifyCustomerAssignedWithRetry");
  assertStringIncludes(bgBlock, "sendRideStopPush");
  assertStringIncludes(bgBlock, "record_booking_delivery");
  assertStringIncludes(bgBlock, "opsLog");
  assertStringIncludes(src, 'phase: "post_canonical_p2"');
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

Deno.test("verification 3–8: expired/cancelled/already-accepted/stacked/scheduled rejection paths remain", async () => {
  const src = await Deno.readTextFile(acceptOfferPath);
  // Competing / already accepted / expired / cancelled handled by RPC + Edge mapping.
  assertStringIncludes(src, "OFFER_EXPIRED");
  assertStringIncludes(src, "OFFER_NOT_PENDING");
  assertStringIncludes(src, "accept_stacked_ride");
  assertStringIncludes(src, "is_urgent_dispatch");
  assertStringIncludes(src, "assertCanAcceptOfferByDriverId");
  // P2 work is scheduled after canonical — response path uses successResponse(withDuration(...data)).
  const afterCanonical = src.slice(
    src.indexOf('perf.mark("CANONICAL_ASSIGNMENT_CONFIRMED")'),
  );
  assertStringIncludes(afterCanonical, "scheduleAcceptOfferBackground");
  assertStringIncludes(afterCanonical, "buildMinimalAcceptedTripSeed");
  // Must not await full trips.* enrichment on critical path after canonical.
  assertEquals(afterCanonical.includes('.from("drivers")'), false);
});

Deno.test("P2 notify retry helper is used; notifications not removed", async () => {
  const helper = await Deno.readTextFile(perfHelperPath);
  assertStringIncludes(helper, "notifyCustomerAssignedWithRetry");
  assertStringIncludes(helper, "for (let i = 0; i < 2; i++)");
  assertStringIncludes(helper, 'event: "driver_assigned"');
  const src = await Deno.readTextFile(acceptOfferPath);
  assertStringIncludes(src, "notifyCustomerAssignedWithRetry");
  assertEquals(src.includes("notifyCustomerTripLifecycle"), true);
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
  assertStringIncludes(helper, "edge_response_build_ms");
});

Deno.test("ingest-telemetry allows Accept waterfall flat metadata keys", async () => {
  const src = await Deno.readTextFile(ingestPath);
  assertStringIncludes(src, '"accept_tap_to_interactive_ms"');
  assertStringIncludes(src, '"accept_edge_rtt_ms"');
  assertStringIncludes(src, '"edge_accept_rpc_ms"');
  assertStringIncludes(src, '"edge_response_build_ms"');
  assertStringIncludes(src, '"perf_id"');
});

Deno.test("accept-offer marks post-assignment skip + P2 notify/delivery stages", async () => {
  const src = await Deno.readTextFile(acceptOfferPath);
  assertStringIncludes(src, "markPostAssignmentEnrichmentSkipped");
  assertStringIncludes(src, "markScheduledGuardSkipped");
  assertStringIncludes(src, "markLockIdempotencySkipped");
  assertStringIncludes(src, 'perf.mark("notification_enqueue")');
  assertStringIncludes(src, 'perf.mark("booking_delivery_start")');
  assertStringIncludes(src, 'perf.mark("booking_delivery_end")');
  // Stacked returns minimal trip seed.
  assertStringIncludes(src, "stackedTripSeed");
  assertStringIncludes(src, "trip: stackedTripSeed");
});

Deno.test("accept_ride_offer / accept_stacked_ride SQL use FOR UPDATE (two-driver race)", async () => {
  const migrationsDir = new URL("../../migrations/", import.meta.url);
  let acceptRide = "";
  let acceptStacked = "";
  for await (const entry of Deno.readDir(migrationsDir)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const text = await Deno.readTextFile(new URL(entry.name, migrationsDir));
    if (text.includes("CREATE OR REPLACE FUNCTION public.accept_ride_offer")) {
      acceptRide = text;
    }
    if (text.includes("CREATE OR REPLACE FUNCTION public.accept_stacked_ride")) {
      acceptStacked = text;
    }
  }
  assertEquals(acceptRide.length > 0, true);
  assertEquals(acceptStacked.length > 0, true);
  assertStringIncludes(acceptRide, "FOR UPDATE");
  assertStringIncludes(acceptStacked, "FOR UPDATE");
});

Deno.test("acceptOfferPerf helper exposes waitUntil scheduling + skip marks", async () => {
  const src = await Deno.readTextFile(perfHelperPath);
  assertStringIncludes(src, "scheduleAcceptOfferBackground");
  assertStringIncludes(src, "buildMinimalAcceptedTripSeed");
  assertStringIncludes(src, "notifyCustomerAssignedWithRetry");
  assertStringIncludes(src, "markPostAssignmentEnrichmentSkipped");
  assertStringIncludes(src, "markScheduledGuardSkipped");
  assertStringIncludes(src, "markLockIdempotencySkipped");
  assertStringIncludes(src, 'from "./scheduleEdgeBackground.ts"');
  const bg = await Deno.readTextFile(
    new URL("../../functions/_shared/scheduleEdgeBackground.ts", import.meta.url),
  );
  assertStringIncludes(bg, "EdgeRuntime.waitUntil");
});
