/**
 * Bug #33B lock: customer_live_locations uses gps_recorded_at as measurement SSOT.
 * updated_at remains DB write time. Older GPS cannot overwrite newer.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20261116120000_customer_live_gps_recorded_at.sql",
    import.meta.url,
  ),
);

Deno.test("Bug #33B migration adds gps_recorded_at and guards out-of-order upserts", () => {
  assertStringIncludes(migration, "ADD COLUMN IF NOT EXISTS gps_recorded_at");
  assertStringIncludes(migration, "p_gps_recorded_at");
  assertStringIncludes(
    migration,
    "EXCLUDED.gps_recorded_at >= customer_live_locations.gps_recorded_at",
  );
  assertStringIncludes(migration, "COALESCE(cll.gps_recorded_at, cll.updated_at)");
  assertStringIncludes(migration, "<= 1127");
  // updated_at stays DB modification time on upsert.
  assertStringIncludes(migration, "updated_at = now()");
  assertEquals(migration.includes("drop column gps_recorded_at"), false);
});
