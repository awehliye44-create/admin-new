/**
 * MK-260815-018 increment coverage lock.
 * Parser must read increment/payment authorised totals. Never sum. Never treat
 * ambiguous POST as a provider decline.
 *
 * Run: deno test --allow-read supabase/functions/_shared/revolutIncrementCoverage018.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyIncrementCoverage,
  revolutProviderAuthorisedTotalPence,
  type RevolutOrder,
} from "./revolutOrders.ts";
import {
  isPriorIncrementAttemptStatus,
  planSameOrderIncrement,
} from "./revolutIncrementAuthorisationSSOT.ts";
import { mapNegotiationCoverFailure } from "./negotiationPayableAuthorisationMap.ts";

const mk018Shape: RevolutOrder = {
  id: "6a805e8c-7844-aff3-a616-a0b521e381e0",
  state: "authorised",
  amount: 695,
  authorised_amount: undefined,
  capture_mode: "manual",
  authorisation_type: "pre_authorisation",
  incremental_authorisations: [
    {
      old_amount: 495,
      new_amount: 695,
      state: "authorised",
    },
  ],
  payments: [
    {
      authorised_amount: 695,
      amount: 695,
    },
  ],
};

Deno.test("A. 495→695 increment via increment/payment fields confirms 695", () => {
  const total = revolutProviderAuthorisedTotalPence(mk018Shape);
  const coverage = classifyIncrementCoverage(mk018Shape, 695);
  assertEquals(total, 695);
  assertEquals(coverage.class, "confirmed");
  assertEquals(coverage.authorisedTotalPence, 695);
});

Deno.test("B. order.authorised_amount null + payments.authorised_amount 695 → 695", () => {
  const order: RevolutOrder = {
    id: "ord",
    state: "AUTHORISED",
    amount: 495,
    authorised_amount: undefined,
    payments: [{ authorised_amount: 695, amount: 695 }],
  };
  assertEquals(revolutProviderAuthorisedTotalPence(order), 695);
  assertEquals(classifyIncrementCoverage(order, 695).class, "confirmed");
});

Deno.test("C. incremental_authorisations new_amount 695 authorised → 695", () => {
  const order: RevolutOrder = {
    id: "ord",
    state: "AUTHORISED",
    amount: 495,
    authorised_amount: undefined,
    incremental_authorisations: [
      { old_amount: 495, new_amount: 695, state: "authorised" },
    ],
  };
  assertEquals(revolutProviderAuthorisedTotalPence(order), 695);
  assertEquals(classifyIncrementCoverage(order, 695).class, "confirmed");
});

Deno.test("D. ambiguous POST then GET 695 → confirmed, no second increment needed", () => {
  const ambiguousPost: RevolutOrder = {
    id: "ord",
    state: "AUTHORISED",
    amount: 495,
    authorised_amount: undefined,
  };
  assertEquals(revolutProviderAuthorisedTotalPence(ambiguousPost), 495);
  assertEquals(classifyIncrementCoverage(ambiguousPost, 695).class, "insufficient");

  const retrieved = mk018Shape;
  const afterGet = classifyIncrementCoverage(retrieved, 695);
  assertEquals(afterGet.class, "confirmed");
  assertEquals(afterGet.authorisedTotalPence, 695);
  assertEquals(planSameOrderIncrement({
    requiredTotalPence: 695,
    providerConfirmedTotalPence: afterGet.authorisedTotalPence,
  }).kind, "not_required");
});

Deno.test("E. GET still 495 after increment attempt → insufficient", () => {
  const stillOriginal: RevolutOrder = {
    id: "ord",
    state: "AUTHORISED",
    amount: 495,
    authorised_amount: 495,
    incremental_authorisations: [
      { old_amount: 495, new_amount: 695, state: "declined" },
    ],
  };
  const coverage = classifyIncrementCoverage(stillOriginal, 695);
  assertEquals(coverage.authorisedTotalPence, 495);
  assertEquals(coverage.class, "insufficient");
});

Deno.test("F. GET pending/processing → unknown/processing, not decline", () => {
  const processing: RevolutOrder = {
    id: "ord",
    state: "processing",
    amount: 495,
    authorised_amount: undefined,
    incremental_authorisations: [
      { old_amount: 495, new_amount: 695, state: "processing" },
    ],
    payments: [{ authorised_amount: 495, amount: 695 }],
  };
  const coverage = classifyIncrementCoverage(processing, 695);
  assertEquals(coverage.class, "processing");
  assertEquals(coverage.authorisedTotalPence, 495);
});

Deno.test("G. provider success + local confirm persist failure is not insufficient", () => {
  const mapped = mapNegotiationCoverFailure({
    errorCode: "INCREMENT_CONFIRM_PERSIST_FAILED",
    error: "Provider authorised the increase but local confirmation failed",
    status: 500,
  });
  assertEquals(mapped.code, "PAYMENT_STATE_PERSIST_FAILED");
  assertEquals(mapped.code === "PAYMENT_AUTHORISATION_INSUFFICIENT", false);
  assertEquals(mapped.message.toLowerCase().includes("insufficient"), false);
});

Deno.test("H. provider already >=695 → no increment plan / no duplicate POST", () => {
  const plan = planSameOrderIncrement({
    requiredTotalPence: 695,
    providerConfirmedTotalPence: 695,
  });
  assertEquals(plan.kind, "not_required");
  assertEquals(isPriorIncrementAttemptStatus("ADDITIONAL_AUTHORISATION_FAILED_TERMINAL"), true);
  assertEquals(isPriorIncrementAttemptStatus("ADDITIONAL_AUTHORISATION_CONFIRMED"), false);
});

Deno.test("I. 495→645→695 uses running target totals, not stacked deltas", () => {
  const first = planSameOrderIncrement({
    requiredTotalPence: 645,
    providerConfirmedTotalPence: 495,
  });
  assertEquals(first.kind, "increment");
  if (first.kind === "increment") {
    assertEquals(first.targetTotalPence, 645);
    assertEquals(first.deltaPence, 150);
  }
  const second = planSameOrderIncrement({
    requiredTotalPence: 695,
    providerConfirmedTotalPence: 645,
  });
  assertEquals(second.kind, "increment");
  if (second.kind === "increment") {
    assertEquals(second.targetTotalPence, 695);
    assertEquals(second.deltaPence, 50);
  }
});

Deno.test("018 shape never sums 495+695 to 1190", () => {
  assertEquals(revolutProviderAuthorisedTotalPence(mk018Shape), 695);
  assertEquals(revolutProviderAuthorisedTotalPence(mk018Shape) === 1190, false);
});

Deno.test("J. Customer counter persists only after cover and waits for Driver", async () => {
  const decision = await Deno.readTextFile(
    new URL("../customer-fare-decision/index.ts", import.meta.url),
  );
  const counterBlock = decision.slice(decision.indexOf('if (action === "COUNTER")'));
  assertEquals(counterBlock.includes("ensureNegotiationPayableAuthorised"), true);
  assertEquals(
    counterBlock.indexOf("ensureNegotiationPayableAuthorised")
      < counterBlock.indexOf('negotiation_status: "waiting_driver_final"'),
    true,
  );
  assertEquals(
    counterBlock.indexOf("ensureNegotiationPayableAuthorised")
      < counterBlock.indexOf("customer_counter_fare"),
    true,
  );
  assertEquals(counterBlock.includes("CUSTOMER_SEND_COUNTER"), true);
});
