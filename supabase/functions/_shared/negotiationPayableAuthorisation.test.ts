/**
 * Negotiation payable cover lock — increment before fare commit / assignment.
 * Run: deno test --allow-read supabase/functions/_shared/negotiationPayableAuthorisation.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isCardLikePaymentMethod,
  isPaymentGateAcceptFailure,
  mapNegotiationCoverFailure,
  NEGOTIATION_PAYABLE_INSUFFICIENT_CODE,
  NEGOTIATION_PAYABLE_INSUFFICIENT_MESSAGE,
} from "./negotiationPayableAuthorisationMap.ts";

Deno.test("card-like methods require increment; cash skips", () => {
  assertEquals(isCardLikePaymentMethod("card"), true);
  assertEquals(isCardLikePaymentMethod("APPLE_PAY"), true);
  assertEquals(isCardLikePaymentMethod("google_pay"), true);
  assertEquals(isCardLikePaymentMethod("cash"), false);
  assertEquals(isCardLikePaymentMethod(null), false);
});

Deno.test("cover failure maps increment decline to payment codes without leaking provider text", () => {
  const insufficient = mapNegotiationCoverFailure({
    errorCode: "AUTHORISED_TOTAL_BELOW_TARGET",
    error: "Provider authorised total remains below the required fare.",
    status: 409,
  });
  assertEquals(insufficient.code, NEGOTIATION_PAYABLE_INSUFFICIENT_CODE);
  assertEquals(insufficient.message, NEGOTIATION_PAYABLE_INSUFFICIENT_MESSAGE);
  assertEquals(insufficient.status, 409);

  const reauth = mapNegotiationCoverFailure({
    errorCode: "CUSTOMER_ACTION_REQUIRED",
    error: "requires_revolut_checkout",
    status: 402,
  });
  assertEquals(reauth.code, "PAYMENT_REAUTH_REQUIRED");
  assertEquals(reauth.status, 402);

  const pending = mapNegotiationCoverFailure({
    errorCode: "authorised_total_not_increased",
    error: "Increment response did not confirm the requested authorised total; retrieve required.",
    status: 409,
  });
  assertEquals(pending.code, "AUTHORISATION_RECONCILIATION_PENDING");
  assertEquals(pending.message, "Could not confirm payment authorisation. Please try again.");

  const persist = mapNegotiationCoverFailure({
    errorCode: "INCREMENT_CONFIRM_PERSIST_FAILED",
    error: "Provider authorised the increase but local confirmation failed",
    status: 500,
  });
  assertEquals(persist.code, "PAYMENT_STATE_PERSIST_FAILED");
  assertEquals(persist.message.includes("insufficient"), false);
});

Deno.test("payment-gate RPC text is recognized so Edge does not swallow it as ACCEPT_FAILED", () => {
  assertEquals(
    isPaymentGateAcceptFailure(
      "PAYMENT_GATE_NOT_SATISFIED: PAYMENT_AUTHORISATION_INSUFFICIENT authorised=495 required=645",
    ),
    true,
  );
  assertEquals(isPaymentGateAcceptFailure("offer_expired"), false);
});

Deno.test("Customer Accept £Y and Counter £Z increment before fare/assignment mutations", async () => {
  const decision = await Deno.readTextFile(
    new URL("../customer-fare-decision/index.ts", import.meta.url),
  );
  const acceptBlock = decision.slice(
    decision.indexOf('if (action === "ACCEPT")'),
    decision.indexOf('if (action === "DECLINE")'),
  );
  const counterBlock = decision.slice(decision.indexOf('if (action === "COUNTER")'));
  assertEquals(acceptBlock.includes("ensureNegotiationPayableAuthorised"), true);
  assertEquals(
    acceptBlock.indexOf("ensureNegotiationPayableAuthorised")
      < acceptBlock.indexOf("accept_ride_offer"),
    true,
  );
  assertEquals(counterBlock.includes("ensureNegotiationPayableAuthorised"), true);
  assertEquals(
    counterBlock.indexOf("ensureNegotiationPayableAuthorised")
      < counterBlock.indexOf("commit_negotiation_fare"),
    true,
  );
  assertEquals(
    counterBlock.indexOf("ensureNegotiationPayableAuthorised")
      < counterBlock.indexOf('negotiation_status: "waiting_driver_final"'),
    true,
  );
});

Deno.test("Driver Accept £Z increments before accept_ride_offer", async () => {
  const final = await Deno.readTextFile(
    new URL("../driver-fare-final/index.ts", import.meta.url),
  );
  const start = final.indexOf('[driver-fare-final] DRIVER_ACCEPTED_COUNTER');
  const acceptBlock = final.slice(
    start,
    final.indexOf('if (action === "DECLINE")', start),
  );
  assertEquals(acceptBlock.includes("ensureNegotiationPayableAuthorised"), true);
  assertEquals(
    acceptBlock.indexOf("ensureNegotiationPayableAuthorised")
      < acceptBlock.indexOf("accept_ride_offer"),
    true,
  );
  assertEquals(acceptBlock.includes("p_allow_customer_counter"), false);
  assertEquals(final.includes("createRevolutOrder"), false);
});

Deno.test("helper reuses same-order increment and never opens a second checkout", async () => {
  const helper = await Deno.readTextFile(
    new URL("./negotiationPayableAuthorisation.ts", import.meta.url),
  );
  const increment = await Deno.readTextFile(
    new URL("./executeSameOrderIncrementSSOT.ts", import.meta.url),
  );
  const topUp = await Deno.readTextFile(
    new URL("./revolutModTopUp.ts", import.meta.url),
  );
  assertEquals(helper.includes("prepareRevolutModificationAuthorisation"), true);
  assertEquals(helper.includes("allowControlledFallback: false"), true);
  assertEquals(helper.includes("createRevolutOrder"), false);
  assertEquals(helper.includes("persistAuthorisedCover"), true);
  assertEquals(helper.includes("NEGOTIATION_PERSIST_FAILED_CODE"), true);
  assertEquals(helper.includes("if (!coverWrite.ok)"), true);
  const missingTripStart = helper.lastIndexOf("if (tripErr || !trip)");
  const missingTrip = helper.slice(missingTripStart, missingTripStart + 280);
  assertEquals(missingTrip.includes("NEGOTIATION_RECONCILIATION_PENDING_CODE"), true);
  assertEquals(missingTrip.includes("NEGOTIATION_PAYABLE_INSUFFICIENT_CODE"), false);
  assertEquals(increment.includes("incrementRevolutOrderAuthorisation"), true);
  assertEquals(topUp.includes('source: "trip_modification"'), true);
});

Deno.test("accept_ride_offer still asserts payment gate after fare write", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260919130200_p0_accept_reassert_payment_amount_gate.sql",
      import.meta.url,
    ),
  );
  assertEquals(sql.includes("PERFORM public.assert_payment_gate(v_offer.trip_id)"), true);
});
