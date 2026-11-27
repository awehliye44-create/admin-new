/**
 * B3 lock — Accept/Decline parallelism flag-gated; atomic RPC + decline-trip retained.
 *
 * Run: deno test --no-check --allow-read \
 *   supabase/tests/_shared/acceptDeclineB3Lock.test.ts
 */
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../functions/", import.meta.url);

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, root));
}

Deno.test("accept-offer B3 parallelises eligibility∥offer and expands pre-RPC", async () => {
  const src = await read("accept-offer/index.ts");
  assertStringIncludes(src, "isAcceptDeclineB3Enabled");
  assertStringIncludes(src, "b3Parallel");
  assertStringIncludes(src, "loadDriverConfirmedScheduledCommitments");
  assertStringIncludes(src, "preloadedCommitments");
  assertStringIncludes(src, 'rpc("accept_ride_offer"');
  assertStringIncludes(src, '"accept_stacked_ride"');
  // Dual path: ON uses Promise.all for eligibility+offer; OFF keeps sequential.
  assertStringIncludes(src, "assertCanAcceptOfferByDriverIdFast");
  const b3Idx = src.indexOf("if (b3Parallel)");
  assert(b3Idx > 0, "B3 branch present");
  const parallelElig = src.indexOf(
    "Promise.all([\n        assertCanAcceptOfferByDriverIdFast",
    b3Idx,
  );
  assert(parallelElig > b3Idx, "B3 eligibility∥offer Promise.all");
});

Deno.test("commitment gate accepts preloadedCommitments without skipping SQL SSOT comments", async () => {
  const gate = await read("_shared/scheduledCommitmentOfferGateSSOT.ts");
  assertStringIncludes(gate, "preloadedCommitments");
  assertStringIncludes(gate, "loadDriverConfirmedScheduledCommitments");
  assertStringIncludes(gate, "Atomic SQL commitment gate");
});

Deno.test("scheduled-ride-action B3 parallelises pre-RPC gates; RPC unchanged", async () => {
  const src = await read("scheduled-ride-action/index.ts");
  assertStringIncludes(src, "isAcceptDeclineB3Enabled");
  assertStringIncludes(src, "pre_rpc_gates_parallel_ms");
  assertStringIncludes(src, 'rpc("accept_scheduled_ride"');
  assertStringIncludes(src, "checkScheduledCommissionWalletGate");
  assertStringIncludes(src, "assertScheduledJourneyComplianceForDriverTrip");
});

Deno.test("live Decline remains decline-trip (never blocking decline-offer rematch)", async () => {
  const declineTrip = await read("decline-trip/index.ts");
  assertStringIncludes(declineTrip, 'rpc("decline_ride_offer"');
  assertStringIncludes(declineTrip, "scheduleEdgeBackground");
  const declineOffer = await read("decline-offer/index.ts");
  // decline-offer may still await rematch — must not be the live Driver path.
  assertStringIncludes(declineOffer, "auto-dispatch");
});

Deno.test("B3 SSOT defaults OFF and never skips rpc in workload model", async () => {
  const ssot = await read("_shared/acceptDeclineB3SSOT.ts");
  assertStringIncludes(ssot, 'ACCEPT_DECLINE_B3');
  assertStringIncludes(ssot, "return false");
  assertStringIncludes(ssot, "measureAcceptDeclineB3Workload");
  assertStringIncludes(ssot, "rpcMs");
});
