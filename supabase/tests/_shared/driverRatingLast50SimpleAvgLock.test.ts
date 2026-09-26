/**
 * Lock: drivers.display_rating / rating use last-50 simple average SSOT
 * (same window as get_driver_standards), not Bayesian ((5×20)+sum)/(20+count).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20261202130000_driver_rating_last50_simple_avg_ssot.sql",
  import.meta.url,
);

Deno.test("last-50 rating SSOT migration replaces Bayesian protection weight", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assertEquals(sql.includes("v_protection_weight"), false);
  assertEquals(sql.includes("v_baseline"), false);
  assertEquals(sql.includes("LIMIT v_window"), true);
  assertEquals(sql.includes("v_window constant integer := 50"), true);
  assertEquals(
    sql.includes("CREATE OR REPLACE FUNCTION public.recalculate_driver_display_rating"),
    true,
  );
  assertEquals(
    sql.includes("CREATE OR REPLACE FUNCTION public.get_driver_standards"),
    true,
  );
  assertEquals(sql.includes("rf.status IS DISTINCT FROM 'flagged'"), true);
  assertEquals(sql.includes("PERFORM public.recalculate_driver_display_rating"), true);
});
