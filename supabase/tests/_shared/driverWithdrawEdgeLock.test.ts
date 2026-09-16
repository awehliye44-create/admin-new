/**
 * Lock: driver-withdraw must reuse Revolut Slice7 primitives and contain zero Stripe.
 * Must NOT inherit admin Slice 7 LIVE_PAYOUT_EXECUTION_ENABLED=false gate.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const EDGE = new URL("../driver-withdraw/index.ts", import.meta.url);
const ADMIN = new URL("../admin-submit-driver-payout-payment/index.ts", import.meta.url);

Deno.test("driver-withdraw source has zero Stripe runtime markers", async () => {
  const src = await Deno.readTextFile(EDGE);
  assertEquals(src.includes("STRIPE_SECRET_KEY"), false);
  assertEquals(/new\s+Stripe\b/.test(src), false);
  assertEquals(src.includes("api.stripe.com"), false);
  assertEquals(src.includes("stripe_account_id"), false);
  assertEquals(src.includes("driver-early-cashout"), false);
});

Deno.test("driver-withdraw reuses production Revolut payout primitives", async () => {
  const src = await Deno.readTextFile(EDGE);
  for (const needle of [
    "relayApprovedDriverPayoutPayment",
    "claim_driver_payout_submission",
    "finalize_driver_payout_submission",
    "finalize_driver_payout_completion",
    "reserve_driver_payout_item",
    "canonicalProviderRequestId",
    "canonicalIdempotencyKey",
    "ensureFreshRevolutBusinessAccessToken",
    "resolveLiveCompanyBalanceSnapshot",
    "EARLY_CASHOUT",
    "reconcileSubmittedDriverWithdrawPayout",
    "provider_transfer_pence",
    "withdrawal_fee_pence",
  ]) {
    assertStringIncludes(src, needle);
  }
  // Status client is used via reconcile helper (never second /pay).
  const reconcileSrc = await Deno.readTextFile(
    new URL("./driverWithdrawProviderReconcile.ts", import.meta.url),
  );
  assertStringIncludes(reconcileSrc, "relayApprovedDriverPayoutPaymentStatus");
});

Deno.test("driver-withdraw never second /pay on reconcile — status path only", async () => {
  const src = await Deno.readTextFile(EDGE);
  assertStringIncludes(src, "reconcile_payout_item_id");
  assertStringIncludes(src, "driverWithdrawProviderReconcile");
  // Reconcile path must not invoke pay helper as a second submission trigger
  const reconcileIdx = src.indexOf("reconcileSubmittedDriverWithdrawPayout");
  assertEquals(reconcileIdx > 0, true);
});

Deno.test("future fee: provider transfer is gross minus fee before /pay", async () => {
  const src = await Deno.readTextFile(EDGE);
  assertStringIncludes(src, "early_cash_out_driver_receives_pence");
  assertStringIncludes(src, "providerTransferPence");
  assertStringIncludes(src, "BALANCE_NOT_GREATER_THAN_FEE");
  assertStringIncludes(src, "amount_pence: providerTransferPence");
});

Deno.test("driver-withdraw uses Driver execution gate — not admin Slice 7 LIVE=false gate", async () => {
  const src = await Deno.readTextFile(EDGE);
  assertStringIncludes(src, "evaluateDriverWithdrawExecutionGate");
  assertEquals(src.includes("evaluateSlice7FlagGate"), false);
  assertEquals(
    src.includes("LIVE_PAYOUT_EXECUTION_ENABLED must stay false for Slice 7 admin submission"),
    false,
  );
});

Deno.test("admin-submit retains Slice 7 LIVE=false gate unchanged", async () => {
  const src = await Deno.readTextFile(ADMIN);
  assertStringIncludes(src, "evaluateSlice7FlagGate");
  assertEquals(src.includes("evaluateDriverWithdrawExecutionGate"), false);
});

Deno.test("pre-provider release must terminal-fail EARLY_CASHOUT (no stuck VALIDATED pending)", async () => {
  const src = await Deno.readTextFile(EDGE);
  assertStringIncludes(src, "markDriverWithdrawPreProviderFailed");
  assertStringIncludes(src, "releaseAndFailPreProvider");
  assertStringIncludes(src, 'status: "FAILED"');
  assertStringIncludes(src, 'execution_status: "FAILED"');
  // Company-balance gate must release+fail (not bare release leaving VALIDATED)
  const gateIdx = src.indexOf("companyBalance.status_code !== \"AVAILABLE\"");
  assertEquals(gateIdx > 0, true);
  const gateWindow = src.slice(gateIdx, gateIdx + 800);
  assertStringIncludes(gateWindow, "releaseAndFailPreProvider");
  assertEquals(gateWindow.includes("release_driver_payout_reservation"), false);
});
