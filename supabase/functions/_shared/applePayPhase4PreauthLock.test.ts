/**
 * Apple Pay Phase 4 — create-preauth critical path.
 * Eligibility overlaps quote reads. Opaque quote is not loaded twice.
 * Offer still runs. Consume still precedes the provider order.
 * estimate-fare stays off the opaque path.
 */
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const preauth = await Deno.readTextFile(
  new URL("../create-preauth-payment-intent/index.ts", import.meta.url),
);
const revolut = await Deno.readTextFile(
  new URL("./revolutPreauth.ts", import.meta.url),
);
const eligibility = await Deno.readTextFile(
  new URL("./passengerEligibility.ts", import.meta.url),
);

Deno.test("eligibility overlaps quote reads and still blocks the provider order", () => {
  const quoteBranch = preauth.slice(preauth.indexOf("Quote-based path"));
  const orderCall = quoteBranch.indexOf("createRevolutPreauthResponse");
  const overlap = quoteBranch.indexOf(
    "await Promise.all([eligibilityP, fareP, customerP, gatewayP])",
  );
  const blocked = quoteBranch.indexOf("passengerNotEligibleResponse");
  assertStringIncludes(quoteBranch, "eligibilityP");
  assertStringIncludes(quoteBranch, "resolveBestOfferForTrip");
  assertStringIncludes(quoteBranch, "scheduleEdgeBackground");
  assertStringIncludes(quoteBranch, "edge_offer_deferred");
  if (!(overlap >= 0 && blocked > overlap && orderCall > blocked)) {
    throw new Error("eligibility must be awaited before createRevolutPreauthResponse");
  }
  if (quoteBranch.includes("await Promise.all([eligibilityP, fareP, customerP, gatewayP, offerP])")) {
    throw new Error("opaque offer read must not gate the preauth response");
  }
});

Deno.test("opaque quote row is reused; validation and consume stay before the order", () => {
  assertStringIncludes(preauth, "preloadedBookingPaymentQuote: preloadedOpaqueQuote");
  assertStringIncludes(revolut, "preloadedBookingPaymentQuote?.id === opaqueQuoteId");
  assertStringIncludes(revolut, "validateBookingPaymentQuoteForPreauth");
  assertStringIncludes(revolut, "consumeBookingPaymentQuoteViaRpc");
  const fn = revolut.slice(revolut.indexOf("export async function createRevolutPreauthResponse"));
  const pendingAt = fn.indexOf("providerOrderId: null");
  const consumeAt = fn.indexOf("await consumeBookingPaymentQuoteViaRpc");
  const orderAt = fn.indexOf("await postPreauthOrder");
  const linkAt = fn.indexOf("providerOrderId: order.id");
  if (!(pendingAt >= 0 && consumeAt > pendingAt && orderAt > consumeAt && linkAt > orderAt)) {
    throw new Error("pending session, quote consume, provider order, then order link");
  }
  assertStringIncludes(preauth, 'edge_estimate_fare_ms", 0');
  assertStringIncludes(preauth, "quoteFareServerSide");
});

Deno.test("onboarding and suspension both still decide eligibility", () => {
  assertStringIncludes(eligibility, "evaluateCustomerOnboardingLogin");
  assertStringIncludes(eligibility, "loadActiveCustomerSuspension");
  assertStringIncludes(eligibility, "Promise.all");
  const decision = eligibility.indexOf("if (!guard.app_access_allowed)");
  const suspension = eligibility.indexOf("if (suspension.suspended)");
  if (!(decision >= 0 && suspension > decision)) {
    throw new Error("onboarding failure must still win over suspension");
  }
});

Deno.test("previously unstamped preauth spans are on the accounted wall", () => {
  assertStringIncludes(revolut, "edge_quote_revalidate_ms");
  assertStringIncludes(revolut, "edge_quote_consume_ms");
  assertStringIncludes(revolut, "edge_order_link_persist_ms");
  assertStringIncludes(revolut, "edge_auth_event_ms");
});
