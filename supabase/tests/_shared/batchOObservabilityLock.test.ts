/**
 * Batch O (O1–O5) — observability-only locks.
 * No behaviour / financial / TTL / rematch changes.
 *
 * Run: deno test --allow-read supabase/tests/_shared/batchOObservabilityLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../functions/", import.meta.url);

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, root));
}

Deno.test("O1: edgeFunctionTiming captures restore_trigger / cold_start / role", async () => {
  const src = await read("_shared/edgeFunctionTiming.ts");
  assertStringIncludes(src, "restoreTrigger");
  assertStringIncludes(src, "restore_trigger");
  assertStringIncludes(src, "fingerprint_skipped");
  assertStringIncludes(src, "peekColdStartHint");
  assertStringIncludes(src, "cold_start_hint");
});

Deno.test("O1: restore-active-trip logs restore_trigger", async () => {
  const src = await read("restore-active-trip/index.ts");
  assertStringIncludes(src, "restore_trigger");
  assertStringIncludes(src, "RESTORE_ACTIVE_TRIP_START");
  assertEquals(src.includes("restoreTrigger"), true);
});

Deno.test("O2: expire-offers stamps section stages_ms", async () => {
  const src = await read("expire-offers/index.ts");
  assertStringIncludes(src, "createStageClock");
  assertStringIncludes(src, "negotiation_block_start");
  assertStringIncludes(src, "sweep_rpc_start");
  assertStringIncludes(src, "exclusive_rescue_start");
  assertStringIncludes(src, "stale_trip_scan_start");
  assertStringIncludes(src, "rebroadcast_start");
  assertStringIncludes(src, "stages_ms: stageSnapshot");
  assertStringIncludes(src, "cold_start_hint");
  // Semantics unchanged — TTL / rematch helpers still present.
  assertStringIncludes(src, "sweepExpiredOffers");
  assertStringIncludes(src, "runExpireOffersRebroadcastBatch");
});

Deno.test("O4: stop-workflow flags slow complete paths in finishEdgeRequestLog", async () => {
  const src = await read("stop-workflow/index.ts");
  assertStringIncludes(src, "slow_path");
  assertStringIncludes(src, 'action === "complete_trip"');
  assertStringIncludes(src, "complete_trip_durations_ms");
  // B4-0 — error-path stage flush + respondOk marks.
  assertStringIncludes(src, "publishCompleteTripO4");
  assertStringIncludes(src, "completeTripError");
  assertStringIncludes(src, "respond_ok_enter");
  // Tip-window / PENDING fail-closed preserved.
  assertStringIncludes(src, "payment_capture_deferred");
  assertStringIncludes(src, "PENDING_ENTITLEMENT_FAILED");
});
