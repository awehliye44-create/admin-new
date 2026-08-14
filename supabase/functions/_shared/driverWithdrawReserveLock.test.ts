/**
 * Lock: Driver Withdraw reservation migration must widen batch kind only.
 * Weekly reservation race (ACTIVE_RESERVATION_EXISTS) must remain intact.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION =
  "../../migrations/20260814120000_driver_withdraw_reserve_early_cashout.sql";

Deno.test("driver withdraw reserve migration allows EARLY_CASHOUT + WEEKLY_SCHEDULED", async () => {
  const sql = await Deno.readTextFile(new URL(MIGRATION, import.meta.url));
  assertStringIncludes(sql, "reserve_driver_payout_item");
  assertStringIncludes(sql, "EARLY_CASHOUT");
  assertStringIncludes(sql, "WEEKLY_SCHEDULED");
  assertStringIncludes(sql, "ACTIVE_RESERVATION_EXISTS");
  // Must not leave WEEKLY_MONDAY as the only alternate path that still rejects EARLY.
  assertEquals(
    /kind IS DISTINCT FROM 'WEEKLY_SCHEDULED'\s*\n\s*AND v_batch\.kind IS DISTINCT FROM 'EARLY_CASHOUT'/.test(
      sql,
    ),
    true,
  );
  // Completion idempotency includes EARLY_CASHOUT debit type.
  assertStringIncludes(
    sql,
    "AND type IN ('WEEKLY_PAYOUT', 'PAYOUT', 'MANUAL_PAYOUT', 'EARLY_CASHOUT')",
  );
  // Revolut-only withdraw eligibility gate.
  assertStringIncludes(sql, "lower(v_early_provider) IS DISTINCT FROM 'revolut'");
});
