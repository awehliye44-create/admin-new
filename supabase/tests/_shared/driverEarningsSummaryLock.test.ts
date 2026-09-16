/**
 * driver-earnings-summary lock — Today uses economic ?? posting SSOT.
 * Available/Pending remain eligibility SSOT. No money writes / Revolut / commission wallet.
 *
 * Run: deno test --allow-read --no-check supabase/tests/_shared/driverEarningsSummaryLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertFalse } from "https://deno.land/std@0.224.0/assert/assert_false.ts";
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/assert_string_includes.ts";

Deno.test("driver-earnings-summary: todayEarningsSsot + eligibility, no money writes", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/driver-earnings-summary/index.ts", import.meta.url),
  );
  assertStringIncludes(src, 'from "../_shared/todayEarningsSsot.ts"');
  assertStringIncludes(src, "todayEarningsAttributionInstant");
  assertStringIncludes(src, "isTodayEarningsEligibleRow");
  assertStringIncludes(src, "londonCivilDateKey");
  assertStringIncludes(src, "loadDriverWalletEconomicFields");
  assertStringIncludes(src, "mergeBackendEconomicFields");
  assertStringIncludes(src, "fetchDriverPayoutEligibility");
  assertEquals(src.includes('from("payment_sessions")'), false);
  assertFalse(src.includes("loadEconomicEarnedAtEvidence"));
  assertFalse(src.includes("attachEconomicEarnedAt"));
  assertFalse(src.includes(".insert("));
  assertFalse(src.includes(".update("));
  assertFalse(src.includes(".upsert("));
  assertFalse(src.includes(".delete("));
  assertFalse(src.includes("creditCapturedCardTripLedger"));
  assertFalse(src.includes("api.revolut"));
  assertFalse(src.includes("financial_ssot_mismatches"));
  assertFalse(src.includes("financial_ssot_repairs"));
  assertFalse(src.includes("driver_commission_wallet"));
  // Period totals must not use capture fail-closed attribution.
  assertEquals(src.includes("earningsAttributionInstant"), false);
  assertStringIncludes(src, "if (!attributedIso) continue");
});
