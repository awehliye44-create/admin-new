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
  assertStringIncludes(draft, "is_driver_active_trip_snapshot_unactivated_scheduled");
  assertStringIncludes(draft, "is_driver_active_trip_snapshot_scheduled_activated");
  assertStringIncludes(draft, "is_driver_active_trip_snapshot_row_eligible");
  assertStringIncludes(draft, "public.is_driver_active_trip_snapshot_row_eligible(t)");
  assertStringIncludes(draft, "public.driver_active_trip_snapshot_lifecycle_rank(t.status) ASC");
  assertStringIncludes(draft, "SECURITY DEFINER");
  assertStringIncludes(draft, "SET search_path TO 'public'");
  assertStringIncludes(draft, "auth.uid()");
  assertStringIncludes(
    draft,
    "(t.driver_id = v_driver_id OR t.confirmed_driver_id = v_driver_id)",
  );
  assertStringIncludes(draft, "converted_to_instant");
  assertStringIncludes(draft, "driver_en_route");
  assertStringIncludes(draft, "scheduled_jit_activated_at");
  assertStringIncludes(draft, "driver_started_journey_to_pickup_at");
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
    "accepted",
  ]) {
    assert(allowBody.includes(`'${s}'`), `missing allowlist status: ${s}`);
  }
  assert(!/\bUPDATE\s+trips\b/i.test(draft), "draft must not mutate trips");
  assert(!/\bINSERT\s+INTO\s+trips\b/i.test(draft), "draft must not insert trips");
  assertStringIncludes(draft, "driver_active_trip_snapshot_anomaly");
  assertStringIncludes(draft, "get_driver_queued_trips");
});

Deno.test("rollback restores updated_at DESC production selection and drops helpers", async () => {
  const rb = await read(
    `migrations/rollback/rollback_${DRAFT_VERSION}_${DRAFT_NAME}.sql`,
  );
  assertStringIncludes(rb, "DROP FUNCTION IF EXISTS public.is_driver_active_trip_snapshot_status");
  assertStringIncludes(rb, "DROP FUNCTION IF EXISTS public.is_driver_active_trip_snapshot_unactivated_scheduled");
  assertStringIncludes(rb, "DROP FUNCTION IF EXISTS public.is_driver_active_trip_snapshot_row_eligible");
  assertStringIncludes(rb, "ORDER BY t.updated_at DESC NULLS LAST");
  assertStringIncludes(rb, "AND t.status IS DISTINCT FROM 'queued'");
  assertStringIncludes(rb, "CREATE OR REPLACE FUNCTION public.get_driver_active_trip_snapshot");
});

Deno.test("isolated SQL covers mandatory + expanded execution scenarios", async () => {
  const sql = await read("tests/driver_active_trip_snapshot_priority_isolated.sql");
  for (const label of [
    "1 in_progress beats newer scheduled",
    "2 arrived beats newer scheduled",
    "3 heading beats newer scheduled",
    "4 at_stop beats newer scheduled",
    "5 scheduled-only empty active",
    "6 terminal-only empty active",
    "7 activated scheduled restored",
    "8 phase4 activation preserved",
    "9 phase5 departure ack preserved",
    "10 active preferred over queued",
    "11 previous driver cannot restore rematch",
    "12 unrelated driver empty",
    "13 cold start restores active",
    "14 deterministic in_progress wins",
    "14 no automatic trip mutation",
    "15 top-level response keys stable",
    "assigned allowlisted; scheduled not",
    "E1 accept_scheduled_ride future accepted excluded",
    "E2 future assigned scheduled excluded",
    "E3 future confirmed scheduled excluded",
    "E4 future driver_assigned status excluded",
    "E5 active beats newer legacy accepted scheduled",
    "E6 cold start restores genuine active over accepted scheduled",
    "E7 genuine instant accepted included",
    "E8 genuine instant assigned included",
    "E9 activated before pickup time included",
    "E10 phase4 activation recovery preserved",
    "E11 phase5 heading active recovery preserved",
    "E11b phase5 awaiting ack still excluded",
    "E12 converted_to_instant included",
    "E13 rematched scheduled previous driver empty",
    "E14 queued stacked scheduled excluded",
    "E15 past-due unactivated reservation excluded",
    "E16 inconsistent metadata does not suppress in_progress",
  ]) {
    assertStringIncludes(sql, label);
  }
  assertEquals(
    (await Deno.stat(
      `${root}migrations/_draft_review_only/${DRAFT_VERSION}_${DRAFT_NAME}.sql`,
    )).isFile,
    true,
  );
});
