/**
 * driver-earnings-summary consumes SQL economic clocks for period totals.
 * It must not choose captured_at in TypeScript, fall back TEN to created_at,
 * or write money tables.
 *
 * Run: deno test --allow-read --no-check supabase/functions/_shared/driverEarningsSummaryLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertFalse } from "https://deno.land/std@0.224.0/assert/assert_false.ts";
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/assert_string_includes.ts";

Deno.test("driver-earnings-summary boot/import: SQL economic clocks, no money writes", async () => {
  const src = await Deno.readTextFile(
    new URL("../driver-earnings-summary/index.ts", import.meta.url),
  );
  assertStringIncludes(src, 'from "../_shared/economicEarnedAtSSOT.ts"');
  assertStringIncludes(src, "loadDriverWalletEconomicFields");
  assertStringIncludes(src, "mergeBackendEconomicFields");
  assertStringIncludes(src, "earningsAttributionInstant");
  assertStringIncludes(src, "londonCivilDateKey");
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
  assertStringIncludes(src, "if (!attributedIso) continue");
  assertEquals(src.includes("entry.created_at) continue"), false);
});
