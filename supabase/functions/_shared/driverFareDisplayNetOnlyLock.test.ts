/**
 * Admin Driver Fare Display = Net Earnings Only.
 * Run: deno test --allow-read supabase/functions/_shared/driverFareDisplayNetOnlyLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("offer insert trigger stamps offered_driver_net_pence from computed net", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260924130000_stamp_offered_driver_net_pence.sql", import.meta.url),
  );
  assertEquals(sql.includes("NEW.offered_driver_net_pence := v_net_pence;"), true);
  assertEquals(sql.includes("driver_net_fare_pence"), true);
  assertEquals(sql.includes("compute_driver_net_preview_from_gross"), true);
});
