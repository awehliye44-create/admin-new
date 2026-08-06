/**
 * Database uniqueness evidence for driver period invoices.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("DB uniqueness: invoices_driver_period_unique on (driver_id, period_start, period_end)", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260806171000_invoices_driver_period_unique.sql", import.meta.url),
  );
  assertEquals(sql.includes("invoices_driver_period_unique"), true);
  assertEquals(sql.includes("(driver_id, period_start, period_end)"), true);
});
