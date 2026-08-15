/**
 * Increment eligibility for negotiation fare cover.
 * Run: deno test --allow-read supabase/functions/_shared/revolutIncrementAuthorisationSSOT.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateRevolutIncrementEligibility } from "./revolutIncrementAuthorisationSSOT.ts";

const authorisedOrder = {
  id: "ord_1",
  state: "AUTHORISED",
  capture_mode: "manual",
  authorised_amount: 495,
  amount: 495,
};

Deno.test("missing authorisation_type on an authorised manual hold is still increment-eligible", () => {
  const result = evaluateRevolutIncrementEligibility({
    order: {
      ...authorisedOrder,
      payments: [{ payment_method: { type: "card" } }],
    },
    targetTotalAuthorisedPence: 645,
    initialAuthorisedPence: 495,
  });
  assertEquals(result.eligible, true);
  assertEquals(result.reason, "eligible");
});

Deno.test("explicit non-pre-auth type stays ineligible", () => {
  const result = evaluateRevolutIncrementEligibility({
    order: {
      ...authorisedOrder,
      authorisation_type: "final",
      payments: [{ payment_method: { type: "card" } }],
    },
    targetTotalAuthorisedPence: 645,
    initialAuthorisedPence: 495,
  });
  assertEquals(result.eligible, false);
  assertEquals(result.reason, "wrong_authorisation_type");
});

Deno.test("retrieve without payments can use the trip card method as fallback", () => {
  const missing = evaluateRevolutIncrementEligibility({
    order: authorisedOrder,
    targetTotalAuthorisedPence: 645,
    initialAuthorisedPence: 495,
  });
  assertEquals(missing.eligible, false);
  assertEquals(missing.reason, "unsupported_payment_method");

  const fallback = evaluateRevolutIncrementEligibility({
    order: authorisedOrder,
    targetTotalAuthorisedPence: 645,
    initialAuthorisedPence: 495,
    fallbackPaymentMethodType: "card",
  });
  assertEquals(fallback.eligible, true);
  assertEquals(fallback.paymentMethodType, "card");
});

Deno.test("increment orchestrator hydrates payments and passes trip method fallback", async () => {
  const src = await Deno.readTextFile(
    new URL("./executeSameOrderIncrementSSOT.ts", import.meta.url),
  );
  const topUp = await Deno.readTextFile(
    new URL("./revolutModTopUp.ts", import.meta.url),
  );
  assertEquals(src.includes("listRevolutOrderPayments"), true);
  assertEquals(src.includes("fallbackPaymentMethodType"), true);
  assertEquals(topUp.includes("fallbackPaymentMethodType"), true);
  assertEquals(topUp.includes("args.trip.payment_method"), true);
});
