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
  ]) {
    assertStringIncludes(src, needle);
  }
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
