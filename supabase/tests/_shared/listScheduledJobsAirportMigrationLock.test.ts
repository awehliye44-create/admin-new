/**
 * Phase 2 list RPC migration compatibility + rollback lock.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIG = new URL(
  "../../migrations/20270212120000_list_scheduled_jobs_airport_charge_pence.sql",
  import.meta.url,
);
const ROLLBACK = new URL(
  "../../migrations/rollback/rollback_20270212120000_list_scheduled_jobs_airport_charge_pence.sql",
  import.meta.url,
);
const PROD = new URL(
  "../../migrations/20261229120000_list_scheduled_jobs_driver_net_preview.sql",
  import.meta.url,
);

Deno.test("migration preserves auth grants, filters, driver-net, adds airport column", async () => {
  const sql = await Deno.readTextFile(MIG);
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.list_driver_own_scheduled_jobs");
  assertStringIncludes(sql, "current_driver_id()");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.list_driver_own_scheduled_jobs(text) TO authenticated");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.list_driver_own_scheduled_jobs(text) TO service_role");
  assertStringIncludes(sql, "compute_driver_net_preview_from_gross");
  assertStringIncludes(sql, "AS airport_charge_pence");
  assertStringIncludes(sql, "AS driver_net_pence");
  assertStringIncludes(sql, "v_tab = 'confirmed'");
  assertStringIncludes(sql, "scheduled_marketplace_is_open");
  // Additive column — older clients ignore unknown JSON keys.
  assert(!sql.includes("DROP FUNCTION"));
});

Deno.test("rollback restores production RPC body without airport column alias", async () => {
  const rollback = await Deno.readTextFile(ROLLBACK);
  const prod = await Deno.readTextFile(PROD);
  assertStringIncludes(rollback, "CREATE OR REPLACE FUNCTION public.list_driver_own_scheduled_jobs");
  // Production body must not expose AS airport_charge_pence.
  assertEquals(prod.includes("AS airport_charge_pence"), false);
  assertEquals(rollback.includes("AS airport_charge_pence"), false);
  // Net calc still receives airport as compute arg (correct).
  assertStringIncludes(rollback, "COALESCE(t.airport_charge_pence, 0)");
  assertStringIncludes(rollback, "AS driver_net_pence");
});
