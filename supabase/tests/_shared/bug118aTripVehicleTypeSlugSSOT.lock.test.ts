/**
 * #118A — trips.vehicle_type text must mirror vehicle_type_id catalog slug.
 *
 * MK-261126-016: id=pet, text=economy DEFAULT → audit looked like economy while
 * dispatch correctly excluded MK0007 for missing pet category assignment.
 */
import {
  assertStringIncludes,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION =
  "../../migrations/20270304140000_bug118a_trip_vehicle_type_slug_ssot.sql";

Deno.test("#118A migration syncs vehicle_type slug from vehicle_type_id", async () => {
  const sql = await Deno.readTextFile(new URL(MIGRATION, import.meta.url));
  assertStringIncludes(sql, "trips_sync_vehicle_type_slug_from_id");
  assertStringIncludes(sql, "BEFORE INSERT OR UPDATE OF vehicle_type_id, vehicle_type");
  assertStringIncludes(sql, "NEW.vehicle_type := v_slug");
  assertStringIncludes(sql, "FROM public.vehicle_types vt");
  // Must not weaken category gates.
  assert(!sql.includes("missing_required_vehicle_category"));
  assert(!sql.includes("driver_vehicle_categories"));
});
