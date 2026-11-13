/**
 * Lock: concurrency hardening 20270222 (waiting segment single-open + accept lock order).
 *
 * 1. trip_waiting_segments: DB-enforced ONE open segment per waiting session; the Edge
 *    open path is atomic open-or-reuse (heal stays recovery only).
 * 2. accept_ride_offer / accept_stacked_ride: TRIP row FOR UPDATE before the offer row;
 *    public RPC never leaks a raw deadlock (40P01) to the client.
 * 3. Local schema repair for driver_live_locations is idempotent (no data, no prod change).
 *
 * Run: deno test --allow-read supabase/tests/_shared/concurrencyHardening20270222.lock.test.ts
 * If this fails, fix the code — never delete or soften the lock.
 */
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));

const WAITING_MIGRATION =
  "../../migrations/20270222120000_trip_waiting_segments_one_open_per_session.sql";
const ACCEPT_MIGRATION =
  "../../migrations/20270222130000_accept_ride_offer_lock_order_deadlock_fix.sql";
const DLL_MIGRATION =
  "../../migrations/20270222140000_driver_live_locations_local_schema_repair.sql";

Deno.test("waiting migration: unique PARTIAL index per session (pickup = trip, stop = trip+stop_id)", async () => {
  const sql = await read(WAITING_MIGRATION);
  assertStringIncludes(sql, "CREATE UNIQUE INDEX IF NOT EXISTS uq_trip_waiting_segments_one_open_per_session");
  assertStringIncludes(sql, "WHERE ended_at IS NULL");
  assertStringIncludes(sql, "WHEN location_type = 'stop'");
  assertStringIncludes(sql, "COALESCE(stop_id,");
  // Pickup never carries a stop identity; stops are separate sessions.
  assertStringIncludes(sql, "ELSE '00000000-0000-0000-0000-000000000000'::uuid END");
});

Deno.test("waiting migration: atomic open-or-reuse RPC, service_role only, never rewrites history", async () => {
  const sql = await read(WAITING_MIGRATION);
  assertStringIncludes(sql, "FUNCTION public.open_waiting_segment_or_reuse(");
  assertStringIncludes(sql, "ON CONFLICT (");
  assertStringIncludes(sql, "DO NOTHING");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.open_waiting_segment_or_reuse");
  assertStringIncludes(sql, "TO service_role");
  assert(!/\bUPDATE\s+public\.trip_waiting_segments\b/i.test(sql), "migration must not rewrite segment rows");
  assert(!/\bDELETE\s+FROM\s+public\.trip_waiting_segments\b/i.test(sql), "migration must not delete segment rows");
  assert(!/\bpayment|revolut|increment/i.test(sql.replace(/--.*$/gm, "")), "no payment change in a waiting-segment migration");
});

Deno.test("Edge waiting open path uses atomic open-or-reuse, reuses on 23505, heal remains", async () => {
  const src = await read("../../functions/_shared/waitingSegmentClock.ts");
  assertStringIncludes(src, 'supabase.rpc("open_waiting_segment_or_reuse"');
  assertStringIncludes(src, "isOpenSegmentUniqueViolation");
  assertStringIncludes(src, "await openWaitingSegmentOrReuse(supabase, {");
  // Recovery stays.
  assertStringIncludes(src, "planOpenWaitingSegments(openList, counting)");
  assertStringIncludes(src, "closeAllOpenWaitingSegmentsForTrip");
  // The unlocked SELECT-then-bare-INSERT is gone from the sync path.
  const sync = src.slice(src.indexOf("export async function syncWaitingGeofenceClock("));
  assert(!sync.includes('.from("trip_waiting_segments")\n        .insert({'), "sync must not bare-INSERT a segment");
});

Deno.test("accept migration: trip FOR UPDATE precedes offer FOR UPDATE; wrapper retries then returns a domain error", async () => {
  const sql = await read(ACCEPT_MIGRATION);
  // Core: trip lock injected BEFORE the offer lock.
  const tripLock = sql.indexOf("PERFORM 1 FROM public.trips t WHERE t.id = v_lock_trip_id FOR UPDATE;");
  const offerLock = sql.indexOf("SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_offer_id FOR UPDATE;", tripLock);
  assert(tripLock > 0 && offerLock > tripLock, "trip row must be locked before the offer row");
  // Stacked path: same order.
  const stackedTrip = sql.indexOf("PERFORM 1 FROM public.trips t WHERE t.id = v_lock_trip_id FOR UPDATE;", offerLock);
  assert(stackedTrip > offerLock, "accept_stacked_ride must lock the trip first too");
  // Wrapper: deadlock/serialization -> bounded retry -> domain response, never raw SQLSTATE.
  assertStringIncludes(sql, "WHEN deadlock_detected OR serialization_failure THEN");
  assertStringIncludes(sql, "v_max_attempts constant integer := 3");
  assertStringIncludes(sql, "accept_ride_offer_contention_result");
  assertStringIncludes(sql, "'OFFER_NOT_PENDING'");
  assertStringIncludes(sql, "'TRIP_NOT_AVAILABLE'");
  // Core is internal: no client grants.
  assertStringIncludes(sql, "REVOKE ALL ON FUNCTION public.accept_ride_offer_core(uuid, uuid, boolean) FROM service_role;");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.accept_ride_offer(uuid, uuid, boolean) TO service_role;");
  // Patched from the live definition: single-winner / payment gate logic is not re-typed here.
  assertStringIncludes(sql, "pg_get_functiondef('public.accept_ride_offer");
  assert(!/assert_payment_gate|finalize_negotiated_fare|snapshot_accepted_wave_commission/.test(sql.replace(/--.*$/gm, "")),
    "assignment logic must not be re-typed in the lock-order migration");
});

Deno.test("driver_live_locations repair is idempotent schema-only (no data, no prod change)", async () => {
  const sql = await read(DLL_MIGRATION);
  assertStringIncludes(sql, "CREATE TABLE IF NOT EXISTS public.driver_live_locations");
  assertStringIncludes(sql, "CREATE INDEX IF NOT EXISTS idx_dll_loc");
  assertStringIncludes(sql, "FROM pg_policy");
  assert(!/\b(INSERT\s+INTO|UPDATE\s+public|DELETE\s+FROM|DROP\s+TABLE)\b/i.test(sql.replace(/--.*$/gm, "")),
    "repair migration must not write or drop data");
});

Deno.test("isolated harness drives the REAL Start Trip RPC and atomic waiting open", async () => {
  const setup = await read("../scheduled_rematch_waiting_concurrency_isolated.setup.sql");
  const verify = await read("../scheduled_rematch_waiting_concurrency_isolated.sql");
  assertStringIncludes(setup, "public.finalize_pickup_waiting_and_start_trip(p_trip, p_driver)");
  assertStringIncludes(setup, "public.open_waiting_segment_or_reuse(");
  assert(!setup.includes("start_mirror("), "mirror Start must be gone");
  assertStringIncludes(verify, "raw_no_overlapping_open_segments");
  assertStringIncludes(verify, "'PASS'");
  assert(!verify.includes("BLOCKER finalize_pickup_waiting_and_start_trip"), "A.real_start_rpc must not be skippable any more");
});
