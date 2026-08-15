/**
 * Admin Driver Fare Display = Net Earnings Only.
 * Run: deno test --allow-read supabase/functions/_shared/driverFareDisplayNetOnlyLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("offer insert trigger stamps offered_driver_net_pence from wave net", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260924140000_stamp_offer_wave_commission_net.sql", import.meta.url),
  );
  assertEquals(sql.includes("NEW.offered_driver_net_pence := v_net_pence;"), true);
  assertEquals(sql.includes("driver_net_fare_pence"), true);
  assertEquals(sql.includes("resolve_wave_commission_percent(v_wave, 0)"), true);
  assertEquals(sql.includes("compute_driver_net_preview_from_gross"), false);
});

Deno.test("when wave net equals customer fare, snapshot display net uses base commission", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260924150000_stamp_net_display_when_wave_equals_gross.sql", import.meta.url),
  );
  assertEquals(sql.includes("v_display_net := v_net_pence;"), true);
  assertEquals(sql.includes("IF v_net_pence = v_base_pence AND COALESCE(v_base_pct, 0) > 0 THEN"), true);
  assertEquals(sql.includes("'driver_net_fare_pence', v_display_net"), true);
  assertEquals(sql.includes("NEW.offered_driver_net_pence := v_net_pence;"), true);
  assertEquals(sql.includes("resolve_wave_commission_percent(v_wave, 0)"), true);
});
