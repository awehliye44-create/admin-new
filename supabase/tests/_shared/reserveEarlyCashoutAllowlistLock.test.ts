/**
 * Lock: reserve_driver_payout_item must allow EARLY_CASHOUT + WEEKLY_SCHEDULED only.
 * Stage C / sibling rewrites dropped EARLY → live BATCH_NOT_ELIGIBLE on Driver Withdraw.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const FORWARD =
  "../../migrations/20261112200000_reserve_driver_payout_item_early_cashout_allowlist.sql";
const ROLLBACK =
  "../../migrations/rollback/rollback_20261112200000_reserve_driver_payout_item_early_cashout_allowlist.sql";

async function forwardSql(): Promise<string> {
  return await Deno.readTextFile(new URL(FORWARD, import.meta.url));
}

Deno.test("1. EARLY_CASHOUT kind is explicitly allowed", async () => {
  const sql = await forwardSql();
  assertStringIncludes(sql, "DISTINCT FROM 'EARLY_CASHOUT'");
  assertStringIncludes(sql, "DISTINCT FROM 'WEEKLY_SCHEDULED'");
  assertEquals(
    /kind IS DISTINCT FROM 'WEEKLY_SCHEDULED'\s*\n\s*AND v_batch\.kind IS DISTINCT FROM 'EARLY_CASHOUT'/.test(
      sql,
    ),
    true,
  );
});

Deno.test("2. WEEKLY_SCHEDULED remains allowed", async () => {
  const sql = await forwardSql();
  assertStringIncludes(sql, "'WEEKLY_SCHEDULED'");
});

Deno.test("3. unsupported kinds still return BATCH_NOT_ELIGIBLE", async () => {
  const sql = await forwardSql();
  assertStringIncludes(sql, "'BATCH_NOT_ELIGIBLE'");
  // Broken Stage C double-gate (WEEKLY_MONDAY dead path) must not return.
  assertEquals(sql.includes("DISTINCT FROM 'WEEKLY_MONDAY'"), false);
});

Deno.test("4. PROCESSING sibling reserve preserved", async () => {
  const sql = await forwardSql();
  assertStringIncludes(sql, "v_batch_live_in_flight");
  assertStringIncludes(sql, "'PROCESSING'");
});

Deno.test("5. Stage C effective payout helper preserved (not legacy payouts_enabled)", async () => {
  const sql = await forwardSql();
  assertStringIncludes(sql, "driver_effective_payout_allowed");
  assertStringIncludes(sql, "DRIVER_PAYOUT_HELD");
});

Deno.test("6. lineage assert + DRIVER_COLLECTED financial model reject preserved", async () => {
  const sql = await forwardSql();
  assertStringIncludes(sql, "assert_payout_item_ledger_lineage");
  assertStringIncludes(sql, "FINANCIAL_MODEL_VIOLATION");
});

Deno.test("7. ACTIVE_RESERVATION_EXISTS cross-workflow race preserved", async () => {
  const sql = await forwardSql();
  assertStringIncludes(sql, "ACTIVE_RESERVATION_EXISTS");
});

Deno.test("8. destination PROVIDER_VERIFIED gate preserved", async () => {
  const sql = await forwardSql();
  assertStringIncludes(sql, "PROVIDER_LINK_NOT_VERIFIED");
  assertStringIncludes(sql, "DESTINATION_NOT_ACTIVE");
});

Deno.test("9. grants + security definer + search_path preserved", async () => {
  const sql = await forwardSql();
  assertStringIncludes(sql, "SECURITY DEFINER");
  assertStringIncludes(sql, "search_path TO 'public'");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.reserve_driver_payout_item(uuid) TO service_role");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.reserve_driver_payout_item(uuid) TO postgres");
});

Deno.test("10. rollback restores prior gate and fail-closes on in-flight EARLY", async () => {
  const rb = await Deno.readTextFile(new URL(ROLLBACK, import.meta.url));
  assertStringIncludes(rb, "ROLLBACK_BLOCKED_EARLY_CASHOUT_IN_FLIGHT");
  assertStringIncludes(rb, "DISTINCT FROM 'WEEKLY_MONDAY'");
  assertEquals(rb.includes("DISTINCT FROM 'EARLY_CASHOUT'"), false);
});

Deno.test("11. forward migration version is 20261112200000", async () => {
  const sql = await forwardSql();
  assertStringIncludes(sql, "reserve_driver_payout_item");
  // Path identity: file name checked via URL
  assertEquals(
    new URL(FORWARD, import.meta.url).pathname.endsWith(
      "20261112200000_reserve_driver_payout_item_early_cashout_allowlist.sql",
    ),
    true,
  );
});

Deno.test("12. sibling lock migration must not be the sole EARLY source of truth", async () => {
  // Guard: older sibling migration still lacks EARLY — forward must be applied.
  const sibling = await Deno.readTextFile(
    new URL(
      "../../migrations/20260901150000_payout_reserve_sibling_processing_batch.sql",
      import.meta.url,
    ),
  );
  assertEquals(sibling.includes("DISTINCT FROM 'EARLY_CASHOUT'"), false);
  const forward = await forwardSql();
  assertEquals(forward.includes("DISTINCT FROM 'EARLY_CASHOUT'"), true);
});
