/**
 * Merchant cache + warm CAI adopt — financial safety locks.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

Deno.test("merchant cache is isolate-local, env-keyed, TTL-bounded, fail-closed on missing secret", async () => {
  const src = await Deno.readTextFile(
    `${ROOT}functions/_shared/revolutMerchantContext.ts`,
  );
  assertStringIncludes(src, "MERCHANT_CONTEXT_TTL_MS");
  assertStringIncludes(src, "revolut:${environment}");
  assertStringIncludes(src, "merchantContextCache");
  assertStringIncludes(src, "__resetRevolutMerchantContextCacheForTests");
  // Never invent credentials
  assertEquals(src.includes("sk_live_fake"), false);
  assertStringIncludes(src, "Revolut payment is not configured");
});

Deno.test("confirm still mandates Revolut verify after cache / parallel auth", async () => {
  const src = await Deno.readTextFile(
    `${ROOT}functions/confirm-revolut-payment/index.ts`,
  );
  assertStringIncludes(src, "verifyRevolutOrderConfirmedForBooking");
  assertStringIncludes(src, "markPaymentSessionAuthorised");
  assertStringIncludes(src, "resolveRevolutMerchantContext");
});

Deno.test("CTAP retains payable snap + on-path session mark", async () => {
  const src = await Deno.readTextFile(
    `${ROOT}functions/create-trip-after-payment/index.ts`,
  );
  assertStringIncludes(src, "persistBookingPayableSnapshotAfterInsert");
  assertStringIncludes(src, "await markPaymentSessionTripCreated");
  const waitUntilLines = src
    .split("\n")
    .filter((line) => line.includes("EdgeRuntime.waitUntil"));
  assertEquals(
    waitUntilLines.some((line) => line.includes("markPaymentSessionTripCreated")),
    false,
  );
});

Deno.test("lookup-booking-canonical-trip remains read-only ownership-gated", async () => {
  const src = await Deno.readTextFile(
    `${ROOT}functions/lookup-booking-canonical-trip/index.ts`,
  );
  assertStringIncludes(src, "evaluateBookingCanonicalTripLookup");
  assertEquals(src.includes(".insert("), false);
  assertEquals(src.includes("markPaymentSession"), false);
  assertEquals(/from\("trips"\)[\s\S]*\.update\(/.test(src), false);
});

Deno.test("I-1 batch preserves negotiation finalize + rematch imports", async () => {
  const src = await Deno.readTextFile(`${ROOT}functions/expire-offers/index.ts`);
  assertStringIncludes(src, "finalizeNegotiationFailureAndRebroadcast");
  assertStringIncludes(src, "enterDriverSecondChanceAtOriginalFare");
  assertStringIncludes(src, "sweepExpiredOffers");
  assertStringIncludes(src, "runExpireOffersRebroadcastBatch");
  assertStringIncludes(src, "tryAcquireExpireOffersSessionFence");
  assertStringIncludes(src, "assertExpireOffersLeaseOwner");
  assertStringIncludes(src, "customerOfferGuards");
  assertStringIncludes(src, "timedOutOfferGuards");
});
