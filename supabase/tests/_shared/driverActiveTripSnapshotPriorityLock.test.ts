/**
 * MK-261114-002 — driver active-trip snapshot priority lock (draft migration).
 * Run: deno test --allow-read supabase/tests/_shared/driverActiveTripSnapshotPriorityLock.test.ts
 */
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../", import.meta.url).pathname;

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(`${root}${rel}`);
}

Deno.test("draft migration excludes future scheduled and ranks live workflows", async () => {
  const draft = await read(
    "migrations/_draft_review_only/20261114130000_driver_active_trip_snapshot_priority.sql",
  );
  assertStringIncludes(draft, "DO NOT APPLY");
  assertStringIncludes(draft, "MK-261114-002");
  assertStringIncludes(draft, "is_driver_active_trip_snapshot_status");
  assertStringIncludes(draft, "driver_active_trip_snapshot_lifecycle_rank");
  assertStringIncludes(draft, "future scheduled commitments");
  const allowStart = draft.indexOf(
    "CREATE OR REPLACE FUNCTION public.is_driver_active_trip_snapshot_status",
  );
  const allowEnd = draft.indexOf("$helper$;", allowStart);
  const allowBody = draft.slice(allowStart, allowEnd);
  assert(
    !allowBody.includes("'scheduled'") &&
      !allowBody.includes("'scheduled_committed'"),
    "allowlist must not include scheduled statuses",
  );
  assert(
    !draft.includes("ORDER BY t.updated_at DESC NULLS LAST\n  LIMIT 1;"),
    "must not order by updated_at alone",
  );
  assertStringIncludes(
    draft,
    "public.is_driver_active_trip_snapshot_status(t.status)",
  );
  assertStringIncludes(
    draft,
    "public.driver_active_trip_snapshot_lifecycle_rank(t.status) ASC",
  );
  assertStringIncludes(draft, "en_route_to_pickup");
  assertStringIncludes(draft, "in_progress");
  assertStringIncludes(draft, "at_stop");
});

Deno.test("rollback restores previous snapshot RPC and drops helpers", async () => {
  const rb = await read(
    "migrations/rollback/rollback_20261114130000_driver_active_trip_snapshot_priority.sql",
  );
  assertStringIncludes(rb, "DROP FUNCTION IF EXISTS public.is_driver_active_trip_snapshot_status");
  assertStringIncludes(
    rb,
    "DROP FUNCTION IF EXISTS public.driver_active_trip_snapshot_lifecycle_rank",
  );
  assertStringIncludes(rb, "CREATE OR REPLACE FUNCTION public.get_driver_active_trip_snapshot()");
  assertStringIncludes(rb, "ORDER BY t.updated_at DESC NULLS LAST");
});

Deno.test("isolated postgres selection cases cover cold-start priority", async () => {
  const sql = await read(
    "tests/driver_active_trip_snapshot_priority_isolated.sql",
  );
  assertStringIncludes(sql, "active beats newer scheduled");
  assertStringIncludes(sql, "scheduled-only yields empty active");
  assertStringIncludes(sql, "in_progress beats newer driver_assigned");
  assertStringIncludes(sql, "at_stop beats newer en_route");
  assertStringIncludes(sql, "is_driver_active_trip_snapshot_status('scheduled')");
});
