/**
 * Book confirm/lookup + Accept latency cuts (obs + parallelisation only).
 * Financial confirm / atomic assignment / session mark preserved.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

Deno.test("lookup-booking-canonical-trip parallelises customer ∥ CAI trip reads", async () => {
  const src = await Deno.readTextFile(
    `${ROOT}functions/lookup-booking-canonical-trip/index.ts`,
  );
  assertStringIncludes(src, "Promise.all");
  assertStringIncludes(src, 'from("customers")');
  assertStringIncludes(src, 'from("trips")');
  assertStringIncludes(src, "evaluateBookingCanonicalTripLookup");
  // Still read-only — no trip/payment mutations
  assertEquals(src.includes("markPaymentSession"), false);
  assertEquals(src.includes(".insert("), false);
});

Deno.test("confirm-revolut-payment parallelises auth∥body and keeps Revolut verify", async () => {
  const src = await Deno.readTextFile(
    `${ROOT}functions/confirm-revolut-payment/index.ts`,
  );
  assertStringIncludes(src, "Promise.all");
  assertStringIncludes(src, "getClaims");
  assertStringIncludes(src, "verifyRevolutOrderConfirmedForBooking");
  assertStringIncludes(src, 'stages?.mark("provider_verify_end")');
  assertStringIncludes(src, "resolveRevolutMerchantContext");
});

Deno.test("edgeAuth requireAuthenticatedUser retains getUser (revocation / disabled-account safe)", async () => {
  const src = await Deno.readTextFile(`${ROOT}functions/_shared/edgeAuth.ts`);
  // Owner safety: getClaims alone must not replace shared getUser — revoked
  // sessions / disabled accounts must still fail before JWT wall-clock expiry.
  assertStringIncludes(src, "getUser(token)");
  assertEquals(/auth\.getClaims\(token\)/.test(src), false);
  assertStringIncludes(src, "Never weaken auth for latency");
  // Callers that share this helper remain covered by Auth server verification.
  for (const caller of [
    "accept-offer",
    "stop-workflow",
    "decline-offer",
    "scheduled-ride-action",
    "pickup-no-show",
  ]) {
    const callerSrc = await Deno.readTextFile(
      `${ROOT}functions/${caller}/index.ts`,
    );
    assertStringIncludes(callerSrc, "requireAuthenticatedUser");
  }
});

Deno.test("accept-offer parallelises body parse ∥ driver SELECT after auth", async () => {
  const src = await Deno.readTextFile(`${ROOT}functions/accept-offer/index.ts`);
  assertStringIncludes(src, "requireAuthenticatedUser");
  assertStringIncludes(src, "bodyPromise");
  assertStringIncludes(src, "driverPromise");
  assertStringIncludes(src, "Promise.all([bodyPromise, driverPromise])");
  // Atomic assignment path retained
  assertStringIncludes(src, "accept_ride_offer");
});

Deno.test("revolut merchant context isolate cache wired", async () => {
  const src = await Deno.readTextFile(
    `${ROOT}functions/_shared/revolutMerchantContext.ts`,
  );
  assertStringIncludes(src, "MERCHANT_CONTEXT_TTL_MS");
  assertStringIncludes(src, "merchantContextCache");
  assertStringIncludes(src, "__resetRevolutMerchantContextCacheForTests");
});

Deno.test("CTAP session mark remains on-path (book latency cuts do not reopen waitUntil-only)", async () => {
  const src = await Deno.readTextFile(
    `${ROOT}functions/create-trip-after-payment/index.ts`,
  );
  assertStringIncludes(src, "await markPaymentSessionTripCreated");
  const waitUntilLines = src
    .split("\n")
    .filter((line) => line.includes("EdgeRuntime.waitUntil"));
  assertEquals(
    waitUntilLines.some((line) => line.includes("markPaymentSessionTripCreated")),
    false,
  );
});
