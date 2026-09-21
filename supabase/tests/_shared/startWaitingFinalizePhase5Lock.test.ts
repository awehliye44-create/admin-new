/**
 * Phase 5 Start Trip waiting finalize — lock money SSOT + RPC path.
 *
 * Baseline MK-260921-013: waiting_ssot ≈ 620ms via sequential Edge→DB RTs.
 * Replacement: finalize_pickup_waiting_and_start_trip (one txn).
 *
 * Run: deno test --allow-read supabase/tests/_shared/startWaitingFinalizePhase5Lock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computePickupChargeFromCountedSeconds } from "../../functions/_shared/waitingSegmentClock.ts";

const migrationPath = new URL(
  "../../migrations/20261122140000_finalize_pickup_waiting_and_start_trip_rpc.sql",
  import.meta.url,
);
const phase4MigrationPath = new URL(
  "../../migrations/20261122130000_finalize_stop_waiting_drive_next_rpc.sql",
  import.meta.url,
);
const stopWorkflowPath = new URL(
  "../../functions/stop-workflow/index.ts",
  import.meta.url,
);
const ingestPath = new URL(
  "../../functions/ingest-telemetry/index.ts",
  import.meta.url,
);
const lifecyclePerfPath = new URL(
  "../../functions/_shared/stopWorkflowLifecyclePerf.ts",
  import.meta.url,
);

Deno.test("pickup charge matrix: free / boundary / over / multi-minute (completed intervals)", () => {
  const free = 180; // 3 min free
  const rate = 30;
  const interval = 60;
  const pencePerInterval = Math.round((rate * interval) / 60); // 30
  const cases: Array<{ counted: number; expect: number }> = [
    { counted: 0, expect: 0 },
    { counted: 179, expect: 0 },
    { counted: 180, expect: 0 }, // exact free
    { counted: 181, expect: 0 }, // 1s over — incomplete interval
    { counted: 240, expect: 1 * pencePerInterval }, // 60s paid → 1 interval
    { counted: 300, expect: 2 * pencePerInterval }, // 120s paid → 2 intervals
  ];
  for (const c of cases) {
    const r = computePickupChargeFromCountedSeconds({
      countedSeconds: c.counted,
      freeWaitSeconds: free,
      ratePencePerMinute: rate,
      intervalSeconds: interval,
      maxMinutes: 30,
    });
    assertEquals(r.charge_pence, c.expect, `counted=${c.counted}`);
  }
});

Deno.test("migration defines pickup-scoped finalize + start RPCs", async () => {
  const sql = await Deno.readTextFile(migrationPath);
  assertStringIncludes(sql, "finalize_pickup_waiting_charge");
  assertStringIncludes(sql, "finalize_pickup_waiting_and_start_trip");
  assertStringIncludes(sql, "location_type = 'pickup'");
  assertStringIncludes(sql, "no_trusted_location");
  assertStringIncludes(sql, "FOR UPDATE");
  assertStringIncludes(sql, "SECURITY DEFINER");
  assertStringIncludes(sql, "must_arrive_pickup");
  assertStringIncludes(sql, "already_started");
  assertStringIncludes(sql, "Completed-intervals charge");
  // Must not finalize intermediate stop segments in this migration
  assertEquals(sql.includes("location_type = 'stop'"), false);
  // Must not invent Revolut / wallet / capture
  assertEquals(sql.toLowerCase().includes("revolut"), false);
  assertEquals(sql.toLowerCase().includes("commission_wallet"), false);
});

Deno.test("Phase 4 Drive Next migration remains untouched by Phase 5 file", async () => {
  const p4 = await Deno.readTextFile(phase4MigrationPath);
  assertStringIncludes(p4, "finalize_stop_waiting_and_drive_to_next");
  assertEquals(p4.includes("finalize_pickup_waiting_and_start_trip"), false);
});

Deno.test("stop-workflow Start prefers combined RPC; Drive Next RPC untouched", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  assertStringIncludes(src, "finalize_pickup_waiting_and_start_trip");
  assertStringIncludes(src, "start_waiting_finalize_via");
  assertStringIncludes(src, "start_trip RPC failed; Edge fallback");
  // Phase 4 must remain
  assertStringIncludes(src, "finalize_stop_waiting_and_drive_to_next");
  assertStringIncludes(src, "drive_next_waiting_finalize_via");
});

Deno.test("ingest + lifecycle allowlist Phase 5 start waiting marks", async () => {
  const ingest = await Deno.readTextFile(ingestPath);
  const perf = await Deno.readTextFile(lifecyclePerfPath);
  assertStringIncludes(ingest, '"start_waiting_finalize_rpc_ms"');
  assertStringIncludes(ingest, '"start_waiting_finalize_via"');
  assertStringIncludes(ingest, '"start_waiting_geofence_final_ms"');
  assertStringIncludes(ingest, '"start_waiting_segment_close_ms"');
  assertStringIncludes(ingest, '"start_waiting_charge_calc_ms"');
  assertStringIncludes(perf, "start_waiting_finalize_rpc_ms");
  assertStringIncludes(perf, "start_waiting_geofence_final_ms");
});

Deno.test("Start P2 notification remains scheduleEdgeBackground (off critical path)", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  const startIdx = src.indexOf("case 'start_trip'");
  const nextCase = src.indexOf("case 'arrive_stop'", startIdx);
  const block = src.slice(startIdx, nextCase > 0 ? nextCase : startIdx + 20000);
  assertStringIncludes(block, 'scheduleEdgeBackground');
  assertStringIncludes(block, 'event: "trip_started"');
  assertStringIncludes(block, "start_trip_p2");
});
