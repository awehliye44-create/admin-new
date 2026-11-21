/**
 * Lock: SQL Wave-1 dispatch_trip_offers(uuid, text) must keep the Towards
 * Destination gate. A full-body rewrite once dropped it (20270227140000); the
 * gate was re-applied in place by 20261121071200. Any NEW full rewrite must carry
 * the gate itself. If this fails, fix the migration — never soften the lock.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

// Full-body rewrites that predate this lock (frozen list — never add to it).
// The live function was re-patched in place by 20261121071200 after the last one.
const KNOWN_PRE_LOCK_REWRITES = new Set([
  "20260524155131_98d1f7d5-f6fa-4493-8bdd-f0cad0036fb0.sql",
  "20260524180120_a6983a7f-6e8e-4349-8a46-abd0a63e4159.sql",
  "20260524183019_70755a53-8644-4761-b692-93af443fd26e.sql",
  "20260524191541_c8c230ef-d8f9-4a2d-914d-76026dd6b8ff.sql",
  "20260524221619_ba602b2b-a0e9-4934-9ef9-f0750d58144b.sql",
  "20260524222813_c3b44441-aaf9-4ea8-a664-7b26ae774540.sql",
  "20260813031500_3fad24aa-201d-45c2-b808-3eba9f5cbac9.sql",
  "20260915120200_dispatch_trip_offers_stacked_queue_cap_fix.sql",
  "20260916120000_retire_scan_go_dispatch_hotfix.sql",
  "20260916120100_fix_dispatch_maybe_advance_call_arity.sql",
  "20260917120000_commission_wallet_dispatch_text_gate.sql",
  "20260921130000_dispatch_gap_close.sql",
  "20260921141000_dispatch_trip_offers_scheduled_handover_skip.sql",
  "20260921142100_dispatch_trip_offers_pending_matches_js.sql",
  "20261028270000_dispatch_location_frozen_degraded_mk260904003.sql",
  "20261203120000_dispatch_online_gate_intent_or_is_online_mk260926004.sql",
  "20261210130000_dispatch_vehicle_category_gate.sql",
  "20261230180000_dispatch_live_new_work_invitation_eligibility.sql",
  "20270101150000_fleet_max_pickup_distance_ssot.sql",
  "20270227140000_stacked_remaining_eta_and_orphan_link_cleanup.sql",
]);

const REWRITE = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.dispatch_trip_offers\s*\(\s*p_trip_id\s+uuid\s*,\s*p_trigger_reason\s+text/i;
const TD_BRANCH = /WHEN\s+NOT\s+public\.towards_destination_sql_wave_allows_driver\([\s\S]*?'towards_destination_mismatch'/;

async function migrationFiles(): Promise<string[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) {
    if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  }
  return names.sort();
}

Deno.test("new full rewrites of dispatch_trip_offers(uuid, text) keep the Towards Destination gate", async () => {
  for (const name of await migrationFiles()) {
    const sql = await Deno.readTextFile(new URL(name, MIGRATIONS));
    if (!REWRITE.test(sql) || KNOWN_PRE_LOCK_REWRITES.has(name)) continue;
    assert(TD_BRANCH.test(sql), `${name} rewrites dispatch_trip_offers without the Towards Destination gate`);
  }
});

Deno.test("Towards Destination gate is re-applied after the 20270227140000 rewrite", async () => {
  const sql = await Deno.readTextFile(
    new URL("20261121071200_378cb52e-2e19-45d2-878d-52eeebe86c41.sql", MIGRATIONS),
  );
  assert(sql.includes("pg_get_functiondef('public.dispatch_trip_offers(uuid, text)'::regprocedure)"));
  assert(TD_BRANCH.test(sql));
  assert(sql.includes("WHEN f.distance_m > v_fleet_max_m THEN ''exceeds_fleet_max_pickup_distance''"));
});
