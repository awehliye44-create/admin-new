/**
 * Batch O2 — observability-only locks (supplement to Batch O).
 * No behaviour / financial / TTL / rematch changes.
 *
 * Run: deno test --allow-read supabase/tests/_shared/batchO2ObservabilityLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../functions/", import.meta.url);

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, root));
}

Deno.test("O2: stop-workflow stamps cold_start_hint via peek/mark", async () => {
  const src = await read("stop-workflow/index.ts");
  assertStringIncludes(src, "peekColdStartHint");
  assertStringIncludes(src, "markEdgeInstanceWarm");
  assertStringIncludes(src, 'peekColdStartHint("stop-workflow")');
  assertStringIncludes(src, "cold_start_hint: coldStartHint");
  assertStringIncludes(src, "slow_path");
  // Financial / tip-window freeze preserved.
  assertStringIncludes(src, "payment_capture_deferred");
  assertStringIncludes(src, "PENDING_ENTITLEMENT_FAILED");
});

Deno.test("O2: client/Edge correlation helper is join-key safe", async () => {
  const src = await read("_shared/clientEdgeDbTimingCorrelation.ts");
  assertStringIncludes(src, "client_action_id");
  assertStringIncludes(src, "perf_id");
  assertStringIncludes(src, "transport_gap_ms");
  assertStringIncludes(src, "trip_suffix alone never joins");
  assertEquals(src.includes("join on trip_suffix"), false);
});

Deno.test("O2: Batch O restore/expire observability still present", async () => {
  const timing = await read("_shared/edgeFunctionTiming.ts");
  assertStringIncludes(timing, "peekColdStartHint");
  const expire = await read("expire-offers/index.ts");
  assertStringIncludes(expire, "cold_start_hint");
  assertStringIncludes(expire, "stages_ms");
});
