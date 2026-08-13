/**
 * Slice 4 lock — Revolut completion / same-order incremental authorisation.
 * Mandatory A–I coverage via pure planners + source locks (no live money movement).
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { planRevolutCompletionCapture } from "./revolutPaymentHoldSSOT.ts";
import {
  evaluateRevolutIncrementEligibility,
  planSameOrderIncrement,
} from "../supabase/functions/_shared/revolutIncrementAuthorisationSSOT.ts";
import { safeCaptureAfterIncrementDecline } from "../supabase/functions/_shared/paymentRecoveryGuardSSOT.ts";
import { decideCaptureAfterRetrieve } from "../supabase/functions/_shared/revolutCaptureIdempotencySSOT.ts";
import {
  durableSettlementColumns,
  needsDurableSettlementPersist,
} from "./durableSettlementOutcomeSSOT.ts";
import {
  isRevolutProviderStateRegression,
  revolutProviderStateRank,
} from "./revolutProviderStateRankSSOT.ts";

const ROOT = new URL("..", import.meta.url).pathname;

Deno.test("Slice4 A: final fare <= authorised → capture exact final once", () => {
  const plan = planRevolutCompletionCapture({
    finalFarePence: 800,
    authorisedHoldPence: 900,
    bufferPence: 999,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan.kind, "capture_within_hold");
  if (plan.kind === "capture_within_hold") {
    assertEquals(plan.capture_amount_pence, 800);
    assertEquals(plan.release_remainder_pence, 100);
  }
});

Deno.test("Slice4 B: final fare > authorised → same_order_increment_required", () => {
  const plan = planRevolutCompletionCapture({
    finalFarePence: 875,
    authorisedHoldPence: 788,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan.kind, "same_order_increment_required");
  if (plan.kind === "same_order_increment_required") {
    assertEquals(plan.shortfall_pence, 87);
    assertEquals(plan.target_total_authorised_pence, 875);
    assertEquals(plan.capture_amount_pence, 875);
    assertEquals(plan.capture_from_original_pence, 788);
  }
  const incr = planSameOrderIncrement({
    requiredTotalPence: 875,
    providerConfirmedTotalPence: 788,
  });
  assertEquals(incr.kind, "increment");
  if (incr.kind === "increment") {
    assertEquals(incr.deltaPence, 87);
    assertEquals(incr.targetTotalPence, 875);
  }
});

Deno.test("Slice4 C: increment succeeds → re-plan capture within new authorised total", () => {
  const afterProviderConfirm = 875;
  const plan = planRevolutCompletionCapture({
    finalFarePence: 875,
    authorisedHoldPence: afterProviderConfirm,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan.kind, "capture_within_hold");
  if (plan.kind === "capture_within_hold") {
    assertEquals(plan.capture_amount_pence, 875);
  }
});

Deno.test("Slice4 D: increment fails → no invented paid; outstanding/recovery correct", () => {
  const safe = safeCaptureAfterIncrementDecline({
    finalFarePence: 875,
    providerConfirmedAuthorisedTotalPence: 788,
  });
  assertEquals(safe.capturePence, 788);
  assertEquals(safe.shortfallPence, 87);
  const cols = durableSettlementColumns("PAYMENT_RECOVERY_REQUIRED", true);
  assertEquals(cols.payment_status, "payment_shortfall");
  assertEquals(cols.payment_status === "captured", false);
});

Deno.test("Slice4 E: partial capture amounts remain partial", () => {
  const safe = safeCaptureAfterIncrementDecline({
    finalFarePence: 1000,
    providerConfirmedAuthorisedTotalPence: 400,
  });
  assertEquals(safe.capturePence, 400);
  assertEquals(safe.shortfallPence, 600);
  const cols = durableSettlementColumns("partial_capture_only", true);
  assertEquals(cols.payment_status.includes("shortfall") || cols.payment_status === "payment_shortfall", true);
});

Deno.test("Slice4 F: retry → reconcile_already_captured (no duplicate capture)", () => {
  const decision = decideCaptureAfterRetrieve({
    paymentSessionId: "sess-1",
    providerOrderId: "ord-1",
    order: { state: "COMPLETED", amount: 875, authorised_amount: 875 } as any,
    finalFarePence: 875,
  });
  assertEquals(decision.action, "reconcile_already_captured");
});

Deno.test("Slice4 G: webhook/provider COMPLETED replay stays idempotent", () => {
  const first = decideCaptureAfterRetrieve({
    paymentSessionId: "sess-1",
    providerOrderId: "ord-1",
    order: { state: "COMPLETED", amount: 800 } as any,
    finalFarePence: 800,
  });
  const second = decideCaptureAfterRetrieve({
    paymentSessionId: "sess-1",
    providerOrderId: "ord-1",
    order: { state: "COMPLETED", amount: 800 } as any,
    finalFarePence: 800,
  });
  assertEquals(first.action, "reconcile_already_captured");
  assertEquals(second.action, "reconcile_already_captured");
  assertEquals(first.action, second.action);
});

Deno.test("Slice4 H: provider state out of order — rank prevents AUTHORISED←CANCELLED regression", () => {
  assertEquals(revolutProviderStateRank("CANCELLED") < revolutProviderStateRank("AUTHORISED"), true);
  assertEquals(isRevolutProviderStateRegression("AUTHORISED", "CANCELLED"), true);
  assertEquals(isRevolutProviderStateRegression("AUTHORISED", "COMPLETED"), false);
});

Deno.test("Slice4 I: trip completion must persist durable settlement (not draft/authorized void)", () => {
  assertEquals(
    needsDurableSettlementPersist({
      paymentStatus: "authorized",
      paymentHoldStatus: null,
      paymentState: "draft",
      finalizeSuccess: false,
      finalizeStatus: "PAYMENT_RECOVERY_REQUIRED",
    }),
    true,
  );
});

Deno.test("Slice4: missing pre_authorisation → increment ineligible (fail closed)", () => {
  const r = evaluateRevolutIncrementEligibility({
    order: {
      id: "ord_no_preauth",
      state: "AUTHORISED",
      capture_mode: "manual",
      amount: 788,
      authorised_amount: 788,
      payments: [{ state: "AUTHORISED", payment_method: { type: "card" } }],
    } as any,
    targetTotalAuthorisedPence: 875,
  });
  assertEquals(r.eligible, false);
  assertEquals(r.reason, "wrong_authorisation_type");
});

Deno.test("Slice4: pre_authorisation + AUTHORISED → increment eligible", () => {
  const r = evaluateRevolutIncrementEligibility({
    order: {
      id: "ord_preauth",
      state: "AUTHORISED",
      capture_mode: "manual",
      authorisation_type: "pre_authorisation",
      amount: 788,
      authorised_amount: 788,
      payments: [{ state: "AUTHORISED", payment_method: { type: "card" } }],
    } as any,
    targetTotalAuthorisedPence: 875,
  });
  assertEquals(r.eligible, true);
  assertEquals(r.reason, "eligible");
});

Deno.test("Slice4 lock: CPI createRevolutOrder path + orders default pre_authorisation", () => {
  const orders = Deno.readTextFileSync(`${ROOT}/supabase/functions/_shared/revolutOrders.ts`);
  const cpi = Deno.readTextFileSync(`${ROOT}/supabase/functions/create-payment-intent/index.ts`);
  const completion = Deno.readTextFileSync(
    `${ROOT}/supabase/functions/_shared/revolutCompletionCapture.ts`,
  );
  assertStringIncludes(cpi, "createRevolutOrder");
  assertStringIncludes(orders, 'authorisation_type: "pre_authorisation"');
  assertStringIncludes(orders, "enableIncrementalAuthorisation");
  assertStringIncludes(orders, "REVOLUT_INCREMENT_API_VERSION");
  assertStringIncludes(orders, "incrementRevolutOrderAuthorisation");
  assertStringIncludes(completion, "preferSameOrderIncrement: true");
  assertStringIncludes(completion, "executeSameOrderIncrement");
  assertStringIncludes(completion, "safeCaptureAfterIncrementDecline");
  // Completion must not invent a replacement hold buffer when prefer-increment is on.
  assertStringIncludes(completion, 'plan.kind === "same_order_increment_required"');
});
