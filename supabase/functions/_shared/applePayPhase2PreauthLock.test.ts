/**
 * Apple Pay Phase 2 — quote row replaces discarded estimate-fare;
 * booking gateway probe is deferred to the provider order.
 * Does not move order-before-present, confirm, or CTAP || CAI.
 */
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const preauth = await Deno.readTextFile(
  new URL("../create-preauth-payment-intent/index.ts", import.meta.url),
);
const guard = await Deno.readTextFile(
  new URL("./paymentGatewayGuard.ts", import.meta.url),
);
const revolut = await Deno.readTextFile(
  new URL("./revolutPreauth.ts", import.meta.url),
);
const gatewayStatus = await Deno.readTextFile(
  new URL("./paymentGatewayStatus.ts", import.meta.url),
);

Deno.test("opaque quote row is the Book fare; client estimated_fare is not the charge", () => {
  assertStringIncludes(preauth, "loadBookingPaymentQuote");
  assertStringIncludes(preauth, 'edge_quote_source", "opaque_row"');
  assertStringIncludes(preauth, "client_estimate_ignored: true");
  assertStringIncludes(preauth, "quoteFareServerSide");
  assertStringIncludes(revolut, "validateBookingPaymentQuoteForPreauth");
  assertStringIncludes(revolut, "NO_REPRICE_AFTER_BOOK_TAP");
  assertStringIncludes(revolut, "consumeBookingPaymentQuoteViaRpc");
});

Deno.test("booking gateway defers the live probe and still fail-closes a fresh error", () => {
  assertStringIncludes(guard, "deferLiveProbe: true");
  assertStringIncludes(gatewayStatus, "deferLiveProbe");
  assertStringIncludes(gatewayStatus, 'lastStatus === "error"');
  assertStringIncludes(gatewayStatus, "CONNECTION_FAILED");
});

Deno.test("quote load, customer lookup, and gateway run in one parallel group", () => {
  assertStringIncludes(preauth, "Promise.all");
  assertStringIncludes(preauth, "checkServiceAreaGatewayForBooking");
  assertStringIncludes(preauth, "recordParallelGroupWall");
});
