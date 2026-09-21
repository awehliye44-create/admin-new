/**
 * Phase 4 Drive Next waiting finalize — lock money SSOT + RPC path.
 *
 * Baseline MK-260921-012: waiting_finalize ≈ 810ms via sequential Edge→DB RTs.
 * Replacement: finalize_stop_waiting_and_drive_to_next (one txn).
 *
 * Run: deno test --allow-read supabase/tests/_shared/driveNextWaitingFinalizePhase4Lock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeStopChargeFromCountedSeconds } from "../../functions/_shared/waitingSegmentClock.ts";

const migrationPath = new URL(
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

Deno.test("charge matrix preserves 012 grace (£0 at 20s / 60s grace)", () => {
  const cases: Array<{ counted: number; expect: number }> = [
    { counted: 20, expect: 0 },
    { counted: 59, expect: 0 },
    { counted: 60, expect: 0 },
    { counted: 61, expect: Math.round((1 / 60) * 30) },
    { counted: 180, expect: Math.round((120 / 60) * 30) },
  ];
  for (const c of cases) {
    const r = computeStopChargeFromCountedSeconds({
      countedSeconds: c.counted,
      freeWaitSeconds: 60,
      ratePencePerMinute: 30,
      maxMinutes: 10,
    });
    assertEquals(r.charge_pence, c.expect, `counted=${c.counted}`);
  }
});

Deno.test("migration defines scoped finalize + drive_to_next RPCs", async () => {
  const sql = await Deno.readTextFile(migrationPath);
  assertStringIncludes(sql, "finalize_stop_waiting_charge");
  assertStringIncludes(sql, "finalize_stop_waiting_and_drive_to_next");
  assertStringIncludes(sql, "location_type = 'stop'");
  assertStringIncludes(sql, "stop_id = p_stop_id");
  assertStringIncludes(sql, "no_trusted_location");
  assertStringIncludes(sql, "FOR UPDATE");
  assertStringIncludes(sql, "SECURITY DEFINER");
  assertStringIncludes(sql, "SET search_path TO 'public'");
  assertStringIncludes(sql, "driver_mismatch");
  assertStringIncludes(sql, "must_arrive_at_stop");
  // Must not touch pickup segments
  assertEquals(sql.includes("location_type = 'pickup'"), false);
});

Deno.test("stop-workflow Drive Next prefers combined RPC", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  assertStringIncludes(src, "finalize_stop_waiting_and_drive_to_next");
  assertStringIncludes(src, "finalize_stop_waiting_charge");
  assertStringIncludes(src, "drive_next_waiting_finalize_via");
  assertStringIncludes(src, "Edge fallback");
});

Deno.test("ingest allowlists drive_next waiting finalize marks", async () => {
  const src = await Deno.readTextFile(ingestPath);
  assertStringIncludes(src, '"drive_next_waiting_finalize_rpc_ms"');
  assertStringIncludes(src, '"waiting_canonical_rpc_ms"');
});
