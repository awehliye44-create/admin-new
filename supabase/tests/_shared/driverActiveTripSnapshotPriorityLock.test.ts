/**
 * MK-261114-002 — driver active-trip snapshot priority lock (draft migration).
 * Run: deno test --allow-read supabase/tests/_shared/driverActiveTripSnapshotPriorityLock.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../", import.meta.url).pathname;
const DRAFT_VERSION = "20270222250000";
const DRAFT_NAME = "driver_active_trip_snapshot_priority";

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(`${root}${rel}`);
}

Deno.test("draft migration version is after remote financial head 20270222240000", async () => {
  assert(DRAFT_VERSION > "20270222240000");
  const draft = await read(
    `migrations/_draft_review_only/${DRAFT_VERSION}_${DRAFT_NAME}.sql`,
  );
  assertStringIncludes(draft, "DO NOT APPLY");
  assertStringIncludes(draft, "MK-261114-002");
  assertStringIncludes(draft, "CREATE OR REPLACE FUNCTION public.get_driver_active_trip_snapshot");
  assertStringIncludes(draft, "CREATE OR REPLACE FUNCTION public.is_driver_active_trip_snapshot_status");
  assertStringIncludes(draft, "CREATE OR REPLACE FUNCTION public.driver_active_trip_snapshot_lifecycle_rank");
  assertStringIncludes(draft, "public.is_driver_active_trip_snapshot_status(t.status)");
  assertStringIncludes(draft, "public.driver_active_trip_snapshot_lifecycle_rank(t.status) ASC");
  assertStringIncludes(draft, "SECURITY DEFINER");
  assertStringIncludes(draft, "SET search_path TO 'public'");
  assertStringIncludes(draft, "auth.uid()");
  assertStringIncludes(
    draft,
    "(t.driver_id = v_driver_id OR t.confirmed_driver_id = v_driver_id)",
  );
  const sel = draft.split("INTO v_trip")[1]?.split("IF FOUND")[0] ?? "";
  assert(
    !/ORDER BY t\.updated_at DESC/.test(sel),
    "selection must not order by updated_at alone",
  );
  const allowStart = draft.indexOf(
    "CREATE OR REPLACE FUNCTION public.is_driver_active_trip_snapshot_status",
  );
  const allowEnd = draft.indexOf("$helper$;", allowStart);
  const allowBody = draft.slice(allowStart, allowEnd);
  assert(!allowBody.includes("'scheduled'"), "scheduled must not be allowlisted");
  assert(
    !allowBody.includes("'scheduled_committed'"),
    "scheduled_committed must not be allowlisted",
  );
  assert(!allowBody.includes("'queued'"), "queued must not be allowlisted");
  for (const s of [
    "assigned",
    "en_route_pickup",
    "en_route_to_pickup",
    "at_pickup",
    "in_progress",
    "en_route_stop",
    "en_route_to_stop",
    "at_stop",
    "en_route_destination",
    "en_route_to_dropoff",
    "pickup_in_progress",
  ]) {
    assert(allowBody.includes(`'${s}'`), `missing allowlist status: ${s}`);
  }
  assert(!/\bUPDATE\s+trips\b/i.test(draft), "draft must not mutate trips");
  assert(!/\bINSERT\s+INTO\s+trips\b/i.test(draft), "draft must not insert trips");
  assertStringIncludes(draft, "driver_active_trip_snapshot_anomaly");
  assertStringIncludes(draft, "get_driver_queued_trips");
  assertStringIncludes(draft, "GRANT EXECUTE ON FUNCTION public.get_driver_active_trip_snapshot()");
});

Deno.test("rollback restores updated_at DESC production selection and drops helpers", async () => {
  const rb = await read(
    `migrations/rollback/rollback_${DRAFT_VERSION}_${DRAFT_NAME}.sql`,
  );
  assertStringIncludes(rb, "DROP FUNCTION IF EXISTS public.is_driver_active_trip_snapshot_status");
  assertStringIncludes(rb, "DROP FUNCTION IF EXISTS public.driver_active_trip_snapshot_lifecycle_rank");
  assertStringIncludes(rb, "ORDER BY t.updated_at DESC NULLS LAST");
  assertStringIncludes(rb, "AND t.status IS DISTINCT FROM 'queued'");
  assertStringIncludes(rb, "CREATE OR REPLACE FUNCTION public.get_driver_active_trip_snapshot");
});

Deno.test("isolated SQL covers mandatory execution scenarios", async () => {
  const sql = await read("tests/driver_active_trip_snapshot_priority_isolated.sql");
  assertStringIncludes(sql, "1 in_progress beats newer scheduled");
  assertStringIncludes(sql, "2 arrived beats newer scheduled");
  assertStringIncludes(sql, "3 heading beats newer scheduled");
  assertStringIncludes(sql, "4 at_stop beats newer scheduled");
  assertStringIncludes(sql, "5 scheduled-only empty active");
  assertStringIncludes(sql, "6 terminal-only empty active");
  assertStringIncludes(sql, "7 activated scheduled restored");
  assertStringIncludes(sql, "8 phase4 activation preserved");
  assertStringIncludes(sql, "9 phase5 departure ack preserved");
  assertStringIncludes(sql, "10 active preferred over queued");
  assertStringIncludes(sql, "11 previous driver cannot restore rematch");
  assertStringIncludes(sql, "12 unrelated driver empty");
  assertStringIncludes(sql, "13 cold start restores active");
  assertStringIncludes(sql, "14 deterministic in_progress wins");
  assertStringIncludes(sql, "14 no automatic trip mutation");
  assertStringIncludes(sql, "15 top-level response keys stable");
  assertStringIncludes(sql, "assigned allowlisted; scheduled not");
  assertEquals(
    (await Deno.stat(
      `${root}migrations/_draft_review_only/${DRAFT_VERSION}_${DRAFT_NAME}.sql`,
    )).isFile,
    true,
  );
});
