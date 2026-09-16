/**
 * Payout completion atomicity — structural/idempotency contract tests (no DB).
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("manual external RPC migration defines idempotency by ref+driver+amount", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260930240000_manual_external_payout_completion_atomic.sql", import.meta.url),
  );
  assertStringIncludes(sql, "finalize_manual_external_payout_completion");
  assertStringIncludes(sql, "DUPLICATE_EXTERNAL_REFERENCE");
  assertStringIncludes(sql, "DRIVER_MISMATCH");
  assertStringIncludes(sql, "AMOUNT_MISMATCH");
  assertStringIncludes(sql, "PAYOUT_LINEAGE_MISMATCH");
  assertStringIncludes(sql, "already_applied");
});

Deno.test("payout completion paths are separated automated vs manual", async () => {
  const src = await Deno.readTextFile(new URL("./payoutCompletionRpcSSOT.ts", import.meta.url));
  assertStringIncludes(src, "invokeAutomatedPayoutCompletion");
  assertStringIncludes(src, "invokeManualExternalPayoutCompletion");
  assertEquals(src.includes("ensureManualPayoutCompletionPrerequisites"), false);
  assertEquals(src.includes("reserve_driver_payout"), false);
});

Deno.test("manual path does not call finalize_driver_payout_completion", async () => {
  const src = await Deno.readTextFile(new URL("./payoutCompletionRpcSSOT.ts", import.meta.url));
  const manualBlock = src.slice(src.indexOf("invokeManualExternalPayoutCompletion"));
  assertStringIncludes(manualBlock, "finalize_manual_external_payout_completion");
  assertEquals(manualBlock.includes("finalize_driver_payout_completion"), false);
});
