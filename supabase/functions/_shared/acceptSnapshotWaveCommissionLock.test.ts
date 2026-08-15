/**
 * Accept-time fare_snapshot_json must overwrite v1 global_base commission keys
 * with the accepted wave (MK-260815-010 dual 74p + 20p).
 *
 * Run: deno test --allow-read supabase/functions/_shared/acceptSnapshotWaveCommissionLock.test.ts
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const sqlPath = new URL(
  "../../migrations/20260924160000_accept_snapshot_wave_commission_ssot.sql",
  import.meta.url,
);

Deno.test("snapshot overwrites generic commission keys from the accepted offer", async () => {
  const sql = await Deno.readTextFile(sqlPath);
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.snapshot_accepted_wave_commission");
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.commit_negotiation_fare");
  assertStringIncludes(sql, "v_offer.effective_commission_percent");
  assertStringIncludes(sql, "'commission_source', 'accepted_wave_snapshot'");
  assertStringIncludes(sql, "'commission_pence', v_commission");
  assertStringIncludes(sql, "'driver_net_pence', v_net");
  assertStringIncludes(sql, "'offered_driver_net_pence', v_offered_net");
  assertStringIncludes(sql, "'accepted_commission_pence', v_commission");
  assertEquals(sql.includes("'commission_pence', CASE WHEN v_settle THEN NULLIF(v_commission_pence, 0)"), false);
});

Deno.test("commit prefers offer effective % before live global_base", async () => {
  const sql = await Deno.readTextFile(sqlPath);
  const commit = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.commit_negotiation_fare"));
  assertStringIncludes(commit, "IF v_offer.effective_commission_percent IS NOT NULL THEN");
  assertStringIncludes(commit, "v_commission_source := 'accepted_wave_snapshot'");
  assertStringIncludes(commit, "v_formula_version := '2'");
  assertEquals(commit.includes("WHEN v_settle AND v_trip.accepted_commission_percent IS NOT NULL THEN 'accepted_wave_snapshot' WHEN v_settle THEN 'global_base'"), false);
});
