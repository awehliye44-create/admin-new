import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Lock: admin-payout-ledger must boot — Slice10 company-balance gate export required.
 * Missing named export → Edge BOOT_ERROR (same class as Payment Sessions).
 */
Deno.test("companyBalanceResolveSSOT exports Slice10 gate used by admin-payout-ledger", async () => {
  const src = await Deno.readTextFile(
    new URL("./companyBalanceResolveSSOT.ts", import.meta.url),
  );
  assertStringIncludes(src, "export async function resolveLiveCompanyBalanceWithSlice10Gate");
  assertStringIncludes(src, "loadPaymentSessionsNetCommissionPence");
  assertStringIncludes(src, "resolveLoadedOperationalReserve");

  const mod = await import("./companyBalanceResolveSSOT.ts");
  assertEquals(typeof mod.resolveLiveCompanyBalanceWithSlice10Gate, "function");
  assertEquals(typeof mod.resolveLiveCompanyBalanceSnapshot, "function");
});

Deno.test("admin-payout-ledger entry imports Slice10 gate (no missing export)", async () => {
  const overview = await Deno.readTextFile(
    new URL("./adminPayoutLedgerOverviewSSOT.ts", import.meta.url),
  );
  const list = await Deno.readTextFile(
    new URL("./adminPayoutLedgerListSSOT.ts", import.meta.url),
  );
  assertStringIncludes(overview, "resolveLiveCompanyBalanceWithSlice10Gate");
  assertStringIncludes(list, "resolveLiveCompanyBalanceWithSlice10Gate");
});
