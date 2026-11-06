/**
 * Live Payout Ledger Available / Next Batch lock.
 *
 * MK truth (PLATFORM_COLLECTED): Available and Next Batch must roll up SQL
 * eligibility balances — never silently omit a driver (Live with £0 Available),
 * and service-area filters must use length > 0 (not >= 0).
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("eligibility batch never silently omits drivers", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/driverWalletEligibilityBalancesRpc.ts", import.meta.url),
  );
  assertStringIncludes(src, "DRIVER_WALLET_ELIGIBILITY_BATCH_INCOMPLETE");
  assertEquals(src.includes("omit — caller fail-closed"), false);
  assertEquals(/catch\s*\{\s*\/\/ omit/.test(src), false);
  assertStringIncludes(src, "one retry");
});

Deno.test("overview / list scope filters use length > 0 (not >= 0)", async () => {
  const overview = await Deno.readTextFile(
    new URL("../../functions/_shared/adminPayoutLedgerOverviewSSOT.ts", import.meta.url),
  );
  const list = await Deno.readTextFile(
    new URL("../../functions/_shared/adminPayoutLedgerListSSOT.ts", import.meta.url),
  );
  assertEquals(overview.includes("length >= 0"), false);
  assertEquals(list.includes("length >= 0"), false);
  assertStringIncludes(overview, "allowed_service_area_ids.length > 0");
  assertStringIncludes(list, "allowed_service_area_ids.length > 0");
  assertStringIncludes(overview, "DRIVER_SECTION_BUDGET_MS = 20_000");
});

Deno.test("accounts overview retries eligibility then fails closed", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/adminPayoutLedgerAccountsOverviewSSOT.ts", import.meta.url),
  );
  assertStringIncludes(src, "ACCOUNTS_OVERVIEW_ELIGIBILITY_INCOMPLETE");
  assertStringIncludes(src, "eligibility failed after retry");
  // Must not soft-return on first eligibility failure (understates Available).
  assertEquals(
    /catch \(eligErr\) \{\s*console\.warn\(\s*"\[admin-payout-ledger\] eligibility failed"/.test(src),
    false,
  );
});

Deno.test("overview Reserved chip prefers explicit 0 over snap null coalesce", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../src/components/finance/PayoutLedgerOverviewPanel.tsx", import.meta.url),
  );
  assertStringIncludes(src, "overview.driver_reserved_pence != null");
  assertEquals(
    src.includes("overview.driver_reserved_pence\n    ?? snap?.driver_payout_reserved_pence"),
    false,
  );
});

Deno.test("overview chips: Pending label is settlement-only; Held/Unbacked is separate", async () => {
  const panel = await Deno.readTextFile(
    new URL("../../../src/components/finance/PayoutLedgerOverviewPanel.tsx", import.meta.url),
  );
  const overview = await Deno.readTextFile(
    new URL("../../functions/_shared/adminPayoutLedgerOverviewSSOT.ts", import.meta.url),
  );
  const dto = await Deno.readTextFile(
    new URL("../../functions/_shared/payoutLedgerOverviewSSOT.ts", import.meta.url),
  );
  assertStringIncludes(panel, 'title="Pending (settlement)"');
  assertEquals(panel.includes("Other Pending / Held"), false);
  assertStringIncludes(panel, 'title="Held / Unbacked"');
  assertStringIncludes(dto, "driver_held_or_unbacked_pence");
  assertStringIncludes(overview, "driver_held_or_unbacked_pence");
  assertStringIncludes(overview, "driver_effective_payout_allowed");
});

Deno.test("driver payouts fleet never paints unknown held count as 0", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../src/pages/PayoutLedger.tsx", import.meta.url),
  );
  assertEquals(src.includes("held_driver_count ?? 0"), false);
  assertStringIncludes(src, "held_driver_count ?? '—'");
  assertStringIncludes(src, "eligible_driver_count ?? '—'");
  assertEquals(src.includes("scheduled_payouts_count ?? 0"), false);
  assertEquals(src.includes("eligible_driver_count ?? b.total_drivers"), false);
  assertStringIncludes(src, "scheduled_payouts_count ?? '—'");
});

Deno.test("DWL fleet Reserved uses WIP only (no included_in_payout_batch coalesce)", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../src/lib/driverWalletFleetOverviewSSOT.ts", import.meta.url),
  );
  assertStringIncludes(src, "withdrawal_in_progress_pence == null");
  // Input type may still declare included_in_payout_batch — reservedPence must not read it.
  const reservedFn = src.slice(src.indexOf("function reservedPence"), src.indexOf("export function buildDriverWalletFleetOverview"));
  assertEquals(reservedFn.includes("included_in_payout_batch_amount_pence"), false);
});
