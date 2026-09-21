/**
 * Lock: Arrive Phase 3 — waiting SSOT latency (money-safe).
 *
 * - pickup waiting start via start_pickup_waiting_on_arrive RPC (on-path)
 * - no duplicate dispatch/stop_waiting settings for radius after config load
 * - trusted GPS parallel with canonical start; geofence skips second ladder
 * - stop waiting reuses preloaded settings (no loadAdminWaitingConfig on start)
 * - P2 audit/notify remain waitUntil; waiting init never off-path
 * - Accept observability marks only (Driver) — not redesigned here
 *
 * Run: deno test --allow-read supabase/tests/_shared/arriveWaitingSsotPhase3PerfLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const stopWorkflowPath = new URL(
  "../../functions/stop-workflow/index.ts",
  import.meta.url,
);
const migrationPath = new URL(
  "../../migrations/20261122120000_start_pickup_waiting_on_arrive_rpc.sql",
  import.meta.url,
);
const perfPath = new URL(
  "../../functions/_shared/stopWorkflowLifecyclePerf.ts",
  import.meta.url,
);
const segmentPath = new URL(
  "../../functions/_shared/waitingSegmentClock.ts",
  import.meta.url,
);
const ingestPath = new URL(
  "../../functions/ingest-telemetry/index.ts",
  import.meta.url,
);

Deno.test("migration defines idempotent start_pickup_waiting_on_arrive RPC", async () => {
  const sql = await Deno.readTextFile(migrationPath);
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.start_pickup_waiting_on_arrive");
  assertStringIncludes(sql, "FOR UPDATE");
  assertStringIncludes(sql, "pickup_waiting_started_at");
  assertStringIncludes(sql, "already_started");
  assertStringIncludes(sql, "GRANT EXECUTE");
  assertStringIncludes(sql, "service_role");
  // Must not reset existing start.
  assertStringIncludes(sql, "IF v_trip.pickup_waiting_started_at IS NOT NULL THEN");
  // Pickup stop mirror must not overwrite intermediate stop waiting.
  assertStringIncludes(sql, "AND type = 'pickup'");
  assertStringIncludes(sql, "AND waiting_started_at IS NULL");
});

Deno.test("ensurePickupWaitingStarted prefers RPC then Edge fallback", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  assertStringIncludes(src, 'start_pickup_waiting_on_arrive');
  assertStringIncludes(src, "PICKUP_WAITING_RPC_FALLBACK");
  assertStringIncludes(src, "via: \"start_pickup_waiting_on_arrive\"");
  // Money: failure still surfaces to Arrive response.
  assertStringIncludes(src, "PICKUP_WAITING_START_FAILED");
  assertStringIncludes(src, "pickup_waiting_started_at missing after Arrived");
});

Deno.test("tryStartPickupWaiting: one settings fetch, parallel trusted+start, no confirm SELECT", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  const fnStart = src.indexOf("async function tryStartPickupWaiting");
  assertEquals(fnStart > 0, true);
  const fnEnd = src.indexOf("async function tryStartStopWaiting", fnStart);
  const block = src.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 12000);

  // Single config load on cold start path (not two sequential SA fetches).
  const configFetchCount = (block.match(/fetchDispatchWaitingSettings/g) ?? []).length;
  // existing-state branch + cold start = 2 max; not 3+.
  assertEquals(configFetchCount <= 2, true);

  assertStringIncludes(block, "Promise.all");
  assertStringIncludes(block, "ensurePickupWaitingStarted");
  assertStringIncludes(block, "resolveTrustedDriverLocation");
  assertStringIncludes(block, "trustedResolved: true");
  assertStringIncludes(block, "waiting_config_start");
  assertStringIncludes(block, "waiting_canonical_rpc_start");
  assertStringIncludes(block, "waiting_geofence_start");

  // Preloaded settings passed into radius check (no second fetch inside check).
  assertStringIncludes(block, "checkPickupArrivalRadius");
  assertStringIncludes(block, "settings,");
});

Deno.test("tryStartStopWaiting reuses settings; skips loadAdminWaitingConfig on start", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  const fnStart = src.indexOf("async function tryStartStopWaiting");
  const fnEnd = src.indexOf("async function checkPickupArrivalRadius", fnStart);
  const tryBlock = src.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 8000);
  assertStringIncludes(tryBlock, "startStopWaitingOnArrive(supabase, trip, stop, settings)");
  assertStringIncludes(tryBlock, "trustedResolved: true");
  assertStringIncludes(tryBlock, "Promise.all");

  const startFn = src.indexOf("async function startStopWaitingOnArrive");
  const startEnd = src.indexOf("async function isStopRadiusEnforced", startFn);
  const startBlock = src.slice(startFn, startEnd > startFn ? startEnd : startFn + 4000);
  assertEquals(startBlock.includes("await loadAdminWaitingConfig"), false);
  assertEquals(startBlock.includes("isStopWaitingChargeEnabled"), false);
  assertStringIncludes(startBlock, "preloadedSettings");
  assertStringIncludes(startBlock, "enable_stop_waiting_charge");
  assertStringIncludes(startBlock, "stop_waiting_grace_period_seconds");
});

Deno.test("waiting geofence accepts pre-resolved trusted (no duplicate ladder)", async () => {
  const src = await Deno.readTextFile(segmentPath);
  assertStringIncludes(src, "trustedResolved");
  assertStringIncludes(src, "openedFresh");
  // Fresh open skips full segment sum SELECT.
  assertStringIncludes(src, "First open segment this session");
});

Deno.test("lifecycle perf emits waiting_* sub-stages", async () => {
  const src = await Deno.readTextFile(perfPath);
  for (const key of [
    "waiting_ssot_total_ms",
    "waiting_trip_context_ms",
    "waiting_config_ms",
    "waiting_existing_state_ms",
    "waiting_canonical_rpc_ms",
    "waiting_geofence_ms",
    "waiting_post_canonical_ms",
  ]) {
    assertStringIncludes(src, key);
  }
});

Deno.test("ingest-telemetry allowlists waiting_* and accept session marks", async () => {
  const src = await Deno.readTextFile(ingestPath);
  for (const key of [
    "waiting_ssot_total_ms",
    "waiting_config_ms",
    "waiting_canonical_rpc_ms",
    "waiting_geofence_ms",
    "accept_get_session_ms",
    "accept_fetch_ms",
    "accept_ttfb_ms",
    "accept_body_parse_ms",
  ]) {
    assertStringIncludes(src, `"${key}"`);
  }
});

Deno.test("arrive_pickup keeps waiting init on-path; audit/notify P2", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  const p2 = src.indexOf("arrive_pickup_p2");
  assertEquals(p2 > 0, true);
  assertStringIncludes(src, "tryStartPickupWaiting");
  assertStringIncludes(src, "pickup_waiting_started_at missing after Arrived");
  // P2 schedule must wrap notify + audits (not removed).
  const scheduleIdx = src.lastIndexOf("scheduleEdgeBackground", p2);
  assertEquals(scheduleIdx > 0, true);
  const p2Block = src.slice(scheduleIdx, p2 + 40);
  assertEquals(p2Block.includes('event: "driver_arrived"'), true);
  assertEquals(p2Block.includes("ARRIVE_AT_PICKUP_TAPPED"), true);
  assertEquals(p2Block.includes("PICKUP_WAITING_STARTED"), true);
  // Waiting start failure remains a blocking Arrive error (money-safe).
  assertStringIncludes(src, "PICKUP_WAITING_START_FAILED");
});

Deno.test("pickup vs stop waiting identity remain separate", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  assertStringIncludes(src, "pickup_waiting_started_at");
  assertStringIncludes(src, "waiting_charge_active");
  assertStringIncludes(src, "stop_waiting_started_at");
  assertStringIncludes(src, "locationType: 'pickup'");
  assertStringIncludes(src, "locationType: 'stop'");
  const sql = await Deno.readTextFile(migrationPath);
  assertStringIncludes(sql, "AND type = 'pickup'");
});

Deno.test("Start / Drive Next / Complete still finalize waiting on-path", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  assertStringIncludes(src, "finalizePickupWaitingOnStartTrip");
  assertStringIncludes(src, "finalizeStopWaitingCharge");
  // Complete keeps payment on-path (Phase 2 lock); waiting close via segments.
  assertStringIncludes(src, "closeOpenWaitingSegments");
  assertStringIncludes(src, "invokeFinalizeTripCapture");
});
