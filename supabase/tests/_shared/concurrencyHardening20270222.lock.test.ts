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
  assertEquals,
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

/**
 * 20270222140000 is a PRODUCTION NO-OP. Production already has public.driver_live_locations, its
 * indexes, RLS and both policies, so every statement below must be an existence-guarded create:
 *   CREATE EXTENSION IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
 *   ENABLE ROW LEVEL SECURITY (idempotent) / CREATE POLICY only behind a pg_policy NOT EXISTS check.
 * Nothing may drop, truncate, rewrite, alter columns, grant/revoke, or touch another table.
 */
Deno.test("driver_live_locations repair 20270222140000 is a prod no-op: only IF NOT EXISTS creates, no DROP / data change", async () => {
  const raw = await read(DLL_MIGRATION);
  // `ON DELETE CASCADE` on the new table's own FK is a column rule, not a DELETE statement.
  const sql = raw.replace(/--.*$/gm, "").replace(/\bON\s+DELETE\s+CASCADE\b/gi, "");

  // Every CREATE is existence-guarded.
  const creates = [...sql.matchAll(/\bCREATE\s+(?!OR\s+REPLACE)([A-Z ]+?)\s+(IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/gi)];
  const unguarded = creates
    .filter((m) => !/^POLICY$/i.test(m[1].trim()))   // policies are guarded by the pg_policy check below
    .filter((m) => !m[2])
    .map((m) => `${m[1].trim()} ${m[3]}`);
  assertEquals(unguarded, [], "every CREATE EXTENSION/TABLE/INDEX must be IF NOT EXISTS");
  assert(!/CREATE\s+OR\s+REPLACE/i.test(sql), "must not replace any function / view on prod");

  // Destructive / rewriting statements are absent.
  for (const [label, re] of [
    ["DROP", /\bDROP\b/i],
    ["TRUNCATE", /\bTRUNCATE\b/i],
    ["DELETE", /\bDELETE\b/i],
    ["INSERT", /\bINSERT\b/i],
    ["UPDATE", /\bUPDATE\b/i],
    ["ALTER COLUMN / ADD / DROP COLUMN", /\bALTER\s+TABLE[^;]*\b(ALTER\s+COLUMN|ADD\s+COLUMN|DROP\s+COLUMN|RENAME)\b/i],
    ["GRANT/REVOKE", /\b(GRANT|REVOKE)\b/i],
    ["COPY", /\bCOPY\b/i],
    ["DISABLE TRIGGER / RLS", /\bDISABLE\b/i],
  ] as Array<[string, RegExp]>) {
    assert(!re.test(sql), `prod no-op migration must not contain ${label}`);
  }

  // The only ALTER is the idempotent RLS enable, on the table this migration itself guards.
  const alters = [...sql.matchAll(/\bALTER\s+TABLE\s+([^\s]+)\s+([A-Z ]+?);/gi)].map((m) => `${m[1]} ${m[2].replace(/\s+/g, " ")}`);
  assertEquals(alters, ["public.driver_live_locations ENABLE ROW LEVEL SECURITY"]);

  // Policies: each CREATE POLICY sits behind an IF NOT EXISTS (… pg_policy …) check.
  const policyCreates = (sql.match(/CREATE\s+POLICY/gi) ?? []).length;
  const policyGuards = (sql.match(/IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_policy/gi) ?? []).length;
  assertEquals(policyGuards, policyCreates, "every CREATE POLICY needs its own pg_policy NOT EXISTS guard");
  assert(policyCreates >= 2);

  // Only ever references the one table (plus the drivers FK target and the has_role() policy helper it calls).
  const tables = new Set([...sql.matchAll(/\bpublic\.([a-z_]+)/gi)].map((m) => m[1].toLowerCase()));
  assertEquals([...tables].sort(), ["driver_live_locations", "drivers", "has_role"]);

  // Wrapped in one transaction so a partial failure cannot leave a half-repair behind.
  assert(/^\s*BEGIN;/m.test(sql) && /^\s*COMMIT;/m.test(sql), "single BEGIN/COMMIT");
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

// ---------------------------------------------------------------------------
// D. Single writer: waitingSegmentClock.ts is the ONLY Edge module that may
//    create trip_waiting_segments rows. Anything else would bypass the atomic
//    open-or-reuse path and re-open the overlapping-open-segment race.
// ---------------------------------------------------------------------------
async function* walkTs(dir: URL): AsyncGenerator<{ url: URL; rel: string }> {
  for await (const entry of Deno.readDir(dir)) {
    const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) {
      if (entry.name === "node_modules" || entry.name === ".tmp") continue;
      yield* walkTs(child);
    } else if (entry.isFile && /\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      yield { url: child, rel: child.pathname };
    }
  }
}

const SEGMENT_TABLE = "trip_waiting_segments";
const SEGMENT_WRITE_PATTERNS: Array<[string, RegExp]> = [
  ["from(...).insert/upsert", /\.from\(\s*["'`]trip_waiting_segments["'`]\s*\)\s*\.(insert|upsert)\s*\(/],
  ["open_waiting_segment_or_reuse rpc", /\.rpc\(\s*["'`]open_waiting_segment_or_reuse["'`]/],
  ["raw INSERT INTO", /\bINSERT\s+INTO\s+(public\.)?trip_waiting_segments\b/i],
  ["raw INSERT via ON CONFLICT upsert helper", /\bupsert\s*\(\s*["'`]trip_waiting_segments["'`]/],
];

Deno.test("no Edge file outside waitingSegmentClock.ts inserts into trip_waiting_segments", async () => {
  const root = new URL("../../functions/", import.meta.url);
  const isWriterModule = (p: string) => p.endsWith("/_shared/waitingSegmentClock.ts");
  const isTestOrFake = (p: string) =>
    /\.(test|spec)\.[tj]sx?$/.test(p) || /\/inMemorySupabaseFake\.ts$/.test(p) || /\/__tests__\//.test(p);

  let scanned = 0;
  let writerHits = 0;
  const violations: string[] = [];
  for await (const { url, rel } of walkTs(root)) {
    if (isTestOrFake(rel)) continue;
    scanned++;
    const src = await Deno.readTextFile(url);
    if (!src.includes(SEGMENT_TABLE) && !src.includes("open_waiting_segment_or_reuse")) continue;
    for (const [label, re] of SEGMENT_WRITE_PATTERNS) {
      if (!re.test(src)) continue;
      if (isWriterModule(rel)) writerHits++;
      else violations.push(`${rel.split("/functions/")[1]} -> ${label}`);
    }
  }

  assert(scanned > 50, `scanner must actually walk supabase/functions (scanned ${scanned})`);
  assert(writerHits > 0, "scanner must see the legitimate writer (waitingSegmentClock.ts) — pattern drift");
  assertEquals(
    violations,
    [],
    "only supabase/functions/_shared/waitingSegmentClock.ts may write trip_waiting_segments; " +
      "route every open through openWaitingSegmentOrReuse",
  );
});
