/**
 * Lock: driver signup catalogue is country + region scoped (never global).
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SRC = await Deno.readTextFile(
  new URL(
    "../../migrations/20261028280000_driver_signup_region_geo_scope.sql",
    import.meta.url,
  ),
);

Deno.test("lock: location options require country and never omit country filter", () => {
  assertEquals(SRC.includes("COUNTRY_REQUIRED"), true);
  assertEquals(SRC.includes("r.country_code = v_country"), true);
  assertEquals(SRC.includes("r.signup_enabled = true"), true);
  assertEquals(SRC.includes("r.status = 'active'"), true);
  assertEquals(SRC.includes("point_in_polygon"), true);
});

Deno.test("lock: service areas hard-scoped to selected region_id", () => {
  assertEquals(SRC.includes("sa.region_id = p_region_id"), true);
  assertEquals(SRC.includes("sa.driver_signup_enabled = true"), true);
  assertEquals(SRC.includes("SERVICE_AREA_REGION_MISMATCH"), true);
  assertEquals(SRC.includes("v_sa.region_id IS DISTINCT FROM p_region_id"), true);
});

Deno.test("lock: no global catalogue fallback when country missing", () => {
  // Empty country returns [] — must not SELECT regions without country predicate.
  const failClosedIdx = SRC.indexOf("COUNTRY_REQUIRED");
  assertEquals(failClosedIdx > 0, true);
  const afterFail = SRC.slice(failClosedIdx, failClosedIdx + 500);
  assertEquals(afterFail.includes("'[]'::jsonb"), true);
  assertEquals(afterFail.includes("regions"), true);
});
