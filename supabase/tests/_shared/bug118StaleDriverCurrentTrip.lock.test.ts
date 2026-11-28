/**
 * #118 — Stale drivers.current_trip_id must not hard-exclude idle drivers.
 *
 * MK-261126-006/007 completed but #113 aborted before complete_trip_p2 cleared
 * the pointer → MK0007/MK0006 stacked_active_count_invalid for hours.
 */
import {
  assertStringIncludes,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION =
  "../../migrations/20270304130000_bug118_stale_driver_current_trip_cleanup.sql";
const STOP = "../../functions/stop-workflow/index.ts";
const SSOT = "../../functions/_shared/clearDriverCurrentTripSSOT.ts";
const AUTO = "../../functions/auto-dispatch/index.ts";
const STACKED = "../../functions/reconcile-stranded-stacked-promotions/lib/stackedPromotionReconcileSSOT.ts";

Deno.test("#118 migration: CAS clear helper, terminal trigger, reconcile RPC", async () => {
  const sql = await Deno.readTextFile(new URL(MIGRATION, import.meta.url));
  assertStringIncludes(sql, "clear_driver_current_trip_if_matches");
  assertStringIncludes(sql, "trips_clear_driver_current_trip_on_terminal");
  assertStringIncludes(sql, "AND current_trip_id = p_trip_id");
  assertStringIncludes(sql, "reconcile_stale_driver_current_trip");
  assertStringIncludes(sql, "STALE_CURRENT_TRIP_CLEARED");
  assertStringIncludes(sql, "trips_reconcile_stale_current_trip_on_search");
  // Stacked queued child must keep pointer for promote.
  assertStringIncludes(sql, "status = 'queued'");
  assert(
    sql.includes("GRANT EXECUTE ON FUNCTION public.reconcile_stale_driver_current_trip(uuid, int) TO service_role"),
  );
  assert(
    sql.includes("REVOKE ALL ON FUNCTION public.reconcile_stale_driver_current_trip(uuid, int) FROM anon"),
  );
});

Deno.test("#118 stop-workflow clears before tip/payment and CAS on idempotent", async () => {
  const src = await Deno.readTextFile(new URL(STOP, import.meta.url));
  assertStringIncludes(src, "clearDriverCurrentTripIfMatches");
  assertStringIncludes(src, "early clear current_trip_id");
  // Early clear must appear before needsProviderSettlement / tip-window block.
  const earlyIdx = src.indexOf("early clear current_trip_id");
  const payIdx = src.indexOf("if (needsProviderSettlement)");
  assert(earlyIdx > 0 && payIdx > earlyIdx, "early clear must precede payment block");
  assertStringIncludes(src, "heal stale pointer even when financial p2 never ran");
  // p2 clear must be CAS (eq current_trip_id), not blind clear by driver id alone.
  assert(
    !src.includes('.update({ current_trip_id: null, updated_at: new Date().toISOString() })\n              .eq("id", driver_id);'),
  );
});

Deno.test("#118 auto-dispatch reconciles before eligibility; stacked skips terminal", async () => {
  const src = await Deno.readTextFile(new URL(AUTO, import.meta.url));
  assertStringIncludes(src, "reconcileStaleDriverCurrentTrip");
  assertStringIncludes(src, "stale_current_trip_reconciled");
  assertStringIncludes(src, "stacked_stale_terminal_current_trip");
});

Deno.test("#118 stacked promote cron heals stale current_trip", async () => {
  const src = await Deno.readTextFile(new URL(STACKED, import.meta.url));
  assertStringIncludes(src, "cleared_stale_current_trip");
  assertStringIncludes(src, "reconcileStaleDriverCurrentTrip");
});

Deno.test("#118 SSOT helper is CAS-only", async () => {
  const src = await Deno.readTextFile(new URL(SSOT, import.meta.url));
  assertStringIncludes(src, '.eq("current_trip_id", tripId)');
  assertStringIncludes(src, "reconcile_stale_driver_current_trip");
});
