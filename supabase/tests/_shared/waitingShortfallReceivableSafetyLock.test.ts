/**
 * Lock: partial-capture shortfall is never only logged.
 *
 * - Capture paths route the shortfall through ensureShortfallReceivableOrException
 *   (receivable → finance exception → ops alert), never the bare receivable call.
 * - The marker write cannot skip the receivable.
 * - The already-captured retry path re-ensures the receivable (idempotent key).
 * - Driver entitlement stays on the full fare; recovered debt is excluded from
 *   every trip-row settlement recompute.
 * - Release refuses to reopen debt the capture already collected.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, root));

const capture = read("functions/_shared/revolutCompletionCapture.ts");
const migration = read("migrations/20261217110000_waiting_shortfall_receivable_safety.sql");

Deno.test("capture paths use the shortfall safety net, not the bare receivable call", () => {
  assert(!capture.includes("recordReceivableAfterDeclinedIncrement"));
  for (const source of ["partial_capture", "zero_capture", "already_captured_retry"]) {
    assert(capture.includes(`source: "${source}"`), `missing ${source}`);
  }
  assertEquals(capture.match(/ensureShortfallReceivableOrException\(/g)?.length, 3);
});

Deno.test("shortfall marker failure cannot skip the receivable", () => {
  const idx = capture.indexOf("await markPaymentSessionPaymentShortfall(args.supabase, {\n              clientActionId,");
  assert(idx > 0);
  const before = capture.slice(Math.max(0, idx - 200), idx);
  assert(before.includes("try {"), "marker write wrapped in try");
  const after = capture.slice(idx, idx + 1200);
  assert(after.indexOf("} catch (markErr)") < after.indexOf("ensureShortfallReceivableOrException("));
});

Deno.test("already-captured retry is bounded to the receivables ledger and uses the trip fare", () => {
  assert(capture.includes("isWithinReceivablesLedger(shortfallSession?.created_at)"));
  const retry = capture.slice(capture.indexOf('source: "already_captured_retry"') - 900, capture.indexOf('source: "already_captured_retry"'));
  assert(retry.includes("finalFarePence > 0"), "retry stores the trip fare, not capture plus shortfall");
});

Deno.test("safety net never moves money or touches driver earnings", () => {
  const safety = read("functions/_shared/shortfallReceivableSafety.ts")
    .split("\n")
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
    .join("\n");
  for (const forbidden of [
    "increment-authorisation",
    "revolut",
    "driver_wallet_ledger",
    "TRIP_EARNING_NET",
    "payout",
    "trips\"",
  ]) {
    assert(!safety.toLowerCase().includes(forbidden.toLowerCase()), `safety net must not reference ${forbidden}`);
  }
  assert(safety.includes("money_moved: false"));
});

Deno.test("trip-row recompute paths exclude recovered debt", () => {
  for (const p of [
    "functions/_shared/capturedTripWalletRecovery.ts",
    "functions/_shared/historicalSettlementCorrectionPlan.ts",
    "functions/financial-ssot-monitor/index.ts",
  ]) {
    const src = read(p);
    assert(src.includes("loadRecoveredDebtFareComponents("), `${p} loads components`);
    assert(src.includes("withRecoveredDebtFareComponent("), `${p} applies components`);
  }
  const repair = read("functions/_shared/driverFinancialReviewRepairSSOT.ts");
  assert(repair.includes("recoveredDebtTripFareComponentPence(evidence)"));
  assert(read("functions/admin-driver-financial-repair/index.ts").includes("receivable_component_pence"));
});

Deno.test("migration: idempotent exception, no delete, frozen evidence, release guard", () => {
  assert(migration.includes("ON CONFLICT (idempotency_key) DO UPDATE"));
  assert(migration.includes("finance_shortfall_exceptions_delete_denied"));
  assert(migration.includes("finance_shortfall_exception_evidence_immutable"));
  assert(migration.includes("v_debt_captured"));
  assert(migration.includes("'refused_debt_captured'"));
  assert(migration.includes("PERFORM public.assert_finance_payout_ledger_access();"));
  assert(!/DROP TABLE/i.test(migration));
  const rollback = read("migrations/rollback/rollback_20261217110000_waiting_shortfall_receivable_safety.sql");
  assert(!/DROP TABLE/i.test(rollback), "rollback keeps financial evidence");
});
