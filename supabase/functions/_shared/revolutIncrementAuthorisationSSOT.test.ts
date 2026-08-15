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

Deno.test("increment persist is a plain insert — never upsert on a guessed unique target", async () => {
  const src = await Deno.readTextFile(
    new URL("./executeSameOrderIncrementSSOT.ts", import.meta.url),
  );
  const persistBlock = src.slice(
    src.indexOf("const incrementReason"),
    src.indexOf("logIncrementEvent(\"increment_required\""),
  );
  assertEquals(persistBlock.includes(".insert(authRow)"), true);
  assertEquals(persistBlock.includes("onConflict"), false);
  assertEquals(persistBlock.includes("payment_session_id,provider_order_id,requested_target_total_pence"), false);
  assertEquals(persistBlock.includes("idempotency_key: businessKey"), true);
  assertEquals(src.includes("incrementRevolutOrderAuthorisation"), true);
  assertEquals(
    src.indexOf(".insert(authRow)")
      < src.indexOf("incrementRevolutOrderAuthorisation({"),
    true,
  );
});

Deno.test("ambiguous increment POST retrieves the same order and never POSTs a second increment", async () => {
  const src = await Deno.readTextFile(
    new URL("./executeSameOrderIncrementSSOT.ts", import.meta.url),
  );
  const incrementCall = src.indexOf("incrementRevolutOrderAuthorisation({");
  const secondIncrementCall = src.indexOf("incrementRevolutOrderAuthorisation({", incrementCall + 1);
  const retrieveAfterPost = src.indexOf("retrieveRevolutOrder(", incrementCall);
  assertEquals(incrementCall > 0, true);
  assertEquals(secondIncrementCall, -1);
  assertEquals(retrieveAfterPost > incrementCall, true);
  assertEquals(src.includes("increment_post_retrieve_reconcile"), true);
  assertEquals(src.includes("hydrateOrderPayments"), true);
  const hydrateAfterRetrieve = src.indexOf("hydrateOrderPayments({", retrieveAfterPost);
  assertEquals(hydrateAfterRetrieve > retrieveAfterPost, true);
  assertEquals(src.includes("INCREMENT_CONFIRM_PERSIST_FAILED"), true);
  assertEquals(src.includes("isPriorIncrementAttemptStatus"), true);
  assertEquals(src.includes("increment_prior_attempt_no_second_post"), true);
  assertEquals(src.includes("ADDITIONAL_AUTHORISATION_FAILED_TERMINAL"), true);
  const terminalIdx = src.indexOf("ADDITIONAL_AUTHORISATION_FAILED_TERMINAL");
  const retrieveIdx = src.indexOf("increment_post_retrieve_reconcile");
  assertEquals(retrieveIdx > 0 && retrieveIdx < terminalIdx, true);
});

Deno.test("persist_failed is not a provider decline and must not trigger safe capture", async () => {
  const completion = await Deno.readTextFile(
    new URL("./revolutCompletionCapture.ts", import.meta.url),
  );
  const fallbackStart = completion.indexOf(
    'incrementResult.kind === "declined"',
  );
  const fallback = completion.slice(
    fallbackStart,
    completion.indexOf("const safe = safeCaptureAfterIncrementDecline", fallbackStart),
  );
  assertEquals(fallback.includes('incrementResult.kind === "declined"'), true);
  assertEquals(fallback.includes('incrementResult.kind === "unsupported"'), true);
  assertEquals(fallback.includes('incrementResult.kind === "provider_limit"'), true);
  assertEquals(fallback.includes('incrementResult.kind === "ineligible"'), true);
  assertEquals(fallback.includes("persist_failed"), false);
  assertEquals(fallback.includes("lock_busy"), false);
  assertEquals(fallback.includes("retryable"), false);
  assertEquals(completion.includes("preferSameOrderIncrement: true"), true);
  assertEquals(completion.includes("executeSameOrderIncrement"), true);
  assertEquals(
    completion.includes(
      "Increment did not confirm an authorised total covering the final fare",
    ),
    true,
  );
  assertEquals(
    completion.includes("original-hold capture is not the primary path"),
    true,
  );
  assertEquals(
    completion.includes("Captured ${safeCapture}p from original order"),
    false,
  );
});
