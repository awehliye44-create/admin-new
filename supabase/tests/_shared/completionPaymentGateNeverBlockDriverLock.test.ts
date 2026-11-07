/**
 * Lock: driver Complete Trip must never be blocked by payment shortfall /
 * unresolved fare-increase. Gate stamps recovery_required and returns ok.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20261230170000_completion_payment_gate_never_block_driver.sql",
  import.meta.url,
);

const STOP = new URL(
  "../../functions/stop-workflow/index.ts",
  import.meta.url,
);

Deno.test("completion gate never returns ok:false for under-protected / unresolved mod", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assertStringIncludes(sql, "assert_trip_completion_customer_payment_gate");
  assertStringIncludes(sql, "under_protected_allow_complete");
  assertStringIncludes(sql, "unresolved_fare_increase_allow_complete");
  assertStringIncludes(sql, "payment_unresolved");
  assertStringIncludes(sql, "recovery_required");
  assertStringIncludes(sql, "financial_model::text");
  assertStringIncludes(sql, "purpose::text");
  // Must not ship the old block messages as ok:false returns.
  assertEquals(sql.includes("completion is blocked"), false);
  assertEquals(sql.includes("'ok', false,\n      'code', 'CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED'"), false);
});

Deno.test("stop-workflow Complete Trip soft-allows payment gate failures", async () => {
  const stop = await Deno.readTextFile(STOP);
  assertStringIncludes(stop, "assertPlatformCollectedCompletionPaymentGate");
  assertStringIncludes(stop, "completion_payment_gate_soft_allow");
  assertStringIncludes(stop, "completion_payment_unresolved_allow");
  // Forbidden: hard-return Action unavailable on gate failure.
  const completeIdx = stop.indexOf("case 'complete_trip'");
  const nextCase = stop.indexOf("case '", completeIdx + 10);
  const completeBlock = stop.slice(completeIdx, nextCase > 0 ? nextCase : undefined);
  assertEquals(completeBlock.includes("return errorResponse(\n              gateResult.code"), false);
  assertEquals(completeBlock.includes("UNRESOLVED_MODIFICATION_CHECK_FAILED"), false);
});
