/**
 * #69A lock — accept-offer pre-RPC collapse, decline-trip deferral, negotiation rematch.
 *
 * Run: deno test --no-check --allow-read supabase/tests/_shared/acceptOfferDecline69aLock.test.ts
 */
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../functions/", import.meta.url);

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, root));
}

Deno.test("accept-offer parallelises pre-RPC reads and keeps accept_ride_offer SSOT", async () => {
  const src = await read("accept-offer/index.ts");
  assertStringIncludes(src, "pre_rpc_parallel_start");
  assertStringIncludes(src, "pre_rpc_parallel_end");
  assertStringIncludes(src, "commitment_gate_start");
  assertStringIncludes(src, "Promise.all([");
  assertStringIncludes(
    src,
    "resolveDriverActiveTripId(supabase, driver_id, authCurrentTripId)",
  );
  assertStringIncludes(src, "current_trip_id, current_lat, current_lng");
  assertStringIncludes(src, 'rpc("accept_ride_offer"');
  assertStringIncludes(src, "scheduleAcceptOfferBackground");
  assert(
    !/from\("trips"\)\s*\.select\(\s*"id, estimated_duration_minutes/.test(src),
    "must not re-fetch candidate trip geometry after hold SELECT",
  );
});

Deno.test("acceptOfferPerf exports pre-RPC gap stages", async () => {
  const perf = await read("accept-offer/lib/acceptOfferPerf.ts");
  assertStringIncludes(perf, "edge_pre_rpc_parallel_ms");
  assertStringIncludes(perf, "edge_commitment_gate_ms");
  assertStringIncludes(perf, "edge_pre_rpc_gap_ms");
});

Deno.test("decline-trip returns after RPC and defers exclusive rescue", async () => {
  const src = await read("decline-trip/index.ts");
  assertStringIncludes(src, 'rpc("decline_ride_offer"');
  assertStringIncludes(src, "scheduleEdgeBackground");
  assertStringIncludes(src, "rescueExclusiveActivationToNearby");
  assertStringIncludes(src, 'finishEdgeRequestLog("decline-trip"');
  assertStringIncludes(src, "createStageClock");
  assertStringIncludes(src, "edge_offer_lookup_ms");
  assertStringIncludes(src, "edge_decline_rpc_ms");
  assertStringIncludes(src, "edge_db_commit_ms");
  const rpcIdx = src.indexOf('rpc("decline_ride_offer"');
  const scheduleIdx = src.indexOf('scheduleEdgeBackground(async () => {', rpcIdx);
  const rescueIdx = src.indexOf("rescueExclusiveActivationToNearby", rpcIdx);
  assert(scheduleIdx > rpcIdx, "post-canonical schedule after decline RPC");
  assert(rescueIdx > scheduleIdx, "rescue inside deferred task");
  assertStringIncludes(src, 'decline-trip-post-canonical');
});

Deno.test("maps decline-trip into EDGE_FUNCTION_PERF_ACTION", async () => {
  const src = await read("_shared/performanceHealthControl.ts");
  assertStringIncludes(src, "'decline-trip': 'edge_decline_trip'");
  assertStringIncludes(src, "edge_decline_trip: 800");
});

Deno.test("negotiation decline defers rematch continuation durably", async () => {
  const rematch = await read("_shared/negotiationFailureRematch.ts");
  assertStringIncludes(rematch, "deferContinuation");
  assertStringIncludes(rematch, "scheduleReliableEdgeNotify");
  assertStringIncludes(rematch, "finalize_negotiation_failure");

  const fareFinal = await read("driver-fare-final/index.ts");
  assertStringIncludes(fareFinal, "deferContinuation: true");
  assertStringIncludes(fareFinal, "deferCustomerNotify: true");
});

Deno.test("activeDriverTripGuard accepts currentTripIdHint", async () => {
  const src = await read("_shared/activeDriverTripGuard.ts");
  assertStringIncludes(src, "currentTripIdHint");
});
