/**
 * Admin Auto-Dispatch Rules → per-wave commission is SSOT for offer net.
 * Run: deno test --allow-read supabase/functions/_shared/waveCommissionAdminSsotLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("stamp trigger uses Admin per-wave table with floor 0", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260924140000_stamp_offer_wave_commission_net.sql", import.meta.url),
  );
  assertEquals(sql.includes("resolve_wave_commission_percent(v_wave, 0)"), true);
  assertEquals(sql.includes("NEW.offered_driver_net_pence := v_net_pence;"), true);
  assertEquals(sql.includes("NEW.effective_commission_percent := v_effective_pct;"), true);
  assertEquals(sql.includes("NEW.wave_commission_reduction_percent := v_reduction_pct;"), true);
  assertEquals(sql.includes("compute_driver_net_preview_from_gross"), false);
  assertEquals(sql.includes("max_wave_commission_reduction_percent"), false);
});

Deno.test("Admin 15/12/9 pp reductions match 0/3/6 effective on 495p fare", () => {
  const base = 15;
  const reductions = [15, 12, 9];
  const expectedEffective = [0, 3, 6];
  const expectedNet = [495, 480, 465];
  for (let i = 0; i < 3; i++) {
    const effective = Math.max(0, base - reductions[i]);
    const commission = Math.round((495 * effective) / 100);
    const net = 495 - commission;
    assertEquals(effective, expectedEffective[i]);
    assertEquals(net, expectedNet[i]);
  }
});
