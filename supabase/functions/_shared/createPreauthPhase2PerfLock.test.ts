/**
 * LOCK — create-preauth Phase 2: skip discarded live estimate-fare when opaque
 * booking_payment_quote is present; reuse single customer row; parallel config.
 *
 * Does NOT weaken: fare SSOT (opaque quote still re-validated in Revolut path),
 * AUTHORISED-before-trip, idempotency, one order / one session.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const indexSrc = await Deno.readTextFile(
  new URL("../create-preauth-payment-intent/index.ts", import.meta.url),
);
const timingSrc = await Deno.readTextFile(
  new URL("./preauthEdgeTimingSSOT.ts", import.meta.url),
);
const revolutSrc = await Deno.readTextFile(
  new URL("./revolutPreauth.ts", import.meta.url),
);

Deno.test("opaque quote skips live estimate-fare HTTP", () => {
  assertStringIncludes(indexSrc, "OPAQUE_QUOTE_SKIP_LIVE_ESTIMATE");
  assertStringIncludes(indexSrc, "loadBookingPaymentQuote");
  assertStringIncludes(indexSrc, "resolvePreauthAmountsFromQuote");
  assertStringIncludes(indexSrc, "setSkippedLiveFareQuote");
  // Live quote remains for non-opaque path.
  assertStringIncludes(indexSrc, "quoteFareServerSide");
});

Deno.test("single customer row reused — no duplicate select before Revolut session", () => {
  assertStringIncludes(indexSrc, "resolvedCustomerId");
  // Must not re-select customers immediately before createRevolutPreauthResponse.
  const revolutCall = indexSrc.indexOf("return await createRevolutPreauthResponse");
  const before = indexSrc.slice(Math.max(0, revolutCall - 800), revolutCall);
  if (before.includes('.from("customers")')) {
    throw new Error("duplicate customers.select immediately before createRevolutPreauthResponse");
  }
});

Deno.test("config hops parallelized (gateway ∥ currency ∥ buffer)", () => {
  assertStringIncludes(indexSrc, "markConfigStart");
  assertStringIncludes(indexSrc, "Promise.all([");
  assertStringIncludes(indexSrc, "checkServiceAreaGateway");
  assertStringIncludes(indexSrc, "resolveRegionCurrency");
});

Deno.test("Phase-2 timing field names present", () => {
  for (const k of [
    "preauth_auth_ms",
    "preauth_context_ms",
    "preauth_quote_ms",
    "preauth_config_ms",
    "preauth_existing_session_ms",
    "preauth_provider_prepare_ms",
    "preauth_provider_request_ms",
    "preauth_provider_response_ms",
    "preauth_persist_ms",
    "preauth_response_build_ms",
    "preauth_edge_total_ms",
  ]) {
    assertStringIncludes(timingSrc, k);
  }
});

Deno.test("existing session + provider prepare marks wired in Revolut path", () => {
  assertStringIncludes(revolutSrc, "markExistingSessionStart");
  assertStringIncludes(revolutSrc, "markProviderPrepareStart");
});

Deno.test("opaque quote still re-validated inside createRevolutPreauthResponse", () => {
  assertStringIncludes(revolutSrc, "validateBookingPaymentQuoteForPreauth");
  assertStringIncludes(revolutSrc, "NO_REPRICE_AFTER_BOOK_TAP");
  assertEquals(revolutSrc.includes("live_server_estimate_ignored_pence"), true);
});
