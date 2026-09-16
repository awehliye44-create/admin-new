/**
 * MK-260916-038 Phase 8: production repair is scoped to future unassigned pollution.
 *
 * Run: deno test --allow-read supabase/tests/_shared/scheduledProductionRepairSSOT.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20261116233000_scheduled_future_unassigned_pollution_repair.sql",
  import.meta.url,
);

Deno.test("Phase 8 repair only touches future unassigned broadcasting+NULL-anchor rows", async () => {
  const src = await Deno.readTextFile(MIGRATION);
  assertStringIncludes(src, "scheduled_status = 'scheduled'");
  assertStringIncludes(src, "compute_scheduled_dispatch_anchors(t.scheduled_at, t.created_at)");
  assertStringIncludes(src, "t.driver_id IS NULL");
  assertStringIncludes(src, "t.confirmed_driver_id IS NULL");
  assertStringIncludes(src, "t.started_at IS NULL");
  assertStringIncludes(src, "t.completed_at IS NULL");
  assertStringIncludes(src, "t.cancelled_at IS NULL");
  assertStringIncludes(src, "t.scheduled_status = 'broadcasting'");
  assertStringIncludes(src, "t.scheduled_broadcast_at IS NULL");
  assertEquals(src.includes("WHERE t.id ="), false, "must not special-case MK-260916-038 by id");
  assert(
    !src.includes("UPDATE public.trips") || src.includes("t.started_at IS NULL"),
    "active/started rows must stay out of the repair",
  );
});
