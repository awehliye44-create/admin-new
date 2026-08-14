/**
 * Lock: driver-withdraw must reuse Revolut Slice7 primitives and contain zero Stripe.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const EDGE = new URL("../driver-withdraw/index.ts", import.meta.url);

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
