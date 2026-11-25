/**
 * #91 — Production-verified same-order incremental authorisation contract lock.
 *
 * Production evidence (read-only; do not mutate):
 * - MK-261125-001: Visa card BIN 465865 → POST total 631 confirmed authorised → capture 631
 * - MK-261125-002: Mastercard BIN 535666 → POST totals 903 then 935 confirmed → capture 935
 *
 * Contrasts (provider rejected after HTTP acceptance; original hold preserved):
 * - MK-261120-005: Apple Pay Visa → target 1546, increment_state=failed
 * - MK-261120-006: Mastercard 535666…2237 → target 1448, increment_state=declined
 *
 * Do NOT change incrementRevolutOrderAuthorisation request semantics to “fix” this lock.
 * If these fail, fix callers / coverage classification — never soften the contract.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  REVOLUT_INCREMENT_API_VERSION,
  classifyIncrementCoverage,
  incrementRevolutOrderAuthorisation,
} from "../../functions/_shared/revolutOrders.ts";
import {
  REVOLUT_MAX_INCREMENT_MULTIPLIER,
  REVOLUT_MAX_INCREMENTS_PER_ORDER,
  buildRevolutIncrementBusinessKey,
  evaluateRevolutIncrementEligibility,
  isRevolutIncrementEligiblePaymentMethod,
} from "../../functions/_shared/revolutIncrementAuthorisationSSOT.ts";
import { planRevolutCompletionCapture } from "../../functions/_shared/revolutPaymentHoldSSOT.ts";
import { resolveProviderConfirmedCapturePence } from "../../functions/_shared/providerConfirmedCaptureEvidenceSSOT.ts";
import { durableSettlementColumns } from "../../functions/finalize-trip-and-capture/lib/durableSettlementOutcomeSSOT.ts";

const ORDERS_SRC = new URL("../../functions/_shared/revolutOrders.ts", import.meta.url);
const EXEC_SRC = new URL(
  "../../functions/_shared/executeSameOrderIncrementSSOT.ts",
  import.meta.url,
);
const PREAUTH_SRC = new URL(
  "../../functions/_shared/revolutPreauthCustomerAttach.ts",
  import.meta.url,
);
const COMPLETION_SRC = new URL(
  "../../functions/_shared/revolutCompletionCapture.ts",
  import.meta.url,
);
const SWEEP_SRC = new URL(
  "../../functions/sweep-revolut-stale-holds/index.ts",
  import.meta.url,
);
const GATE_SRC = new URL(
  "../../functions/_shared/tripModificationPaymentGateSSOT.ts",
  import.meta.url,
);
const OVERLAP_SRC = new URL(
  "../../functions/_shared/preauthPassengerOverlapGateSSOT.ts",
  import.meta.url,
);
const POLICY_SRC = new URL(
  "../../functions/_shared/bookingFinancialPolicySSOT.ts",
  import.meta.url,
);

Deno.test("#91 API version for increment is 2026-04-20 (not create-order version)", () => {
  assertEquals(REVOLUT_INCREMENT_API_VERSION, "2026-04-20");
});

Deno.test("#91 request contract: POST /orders/{id}/increment-authorisation with amount=TOTAL", async () => {
  const src = await Deno.readTextFile(ORDERS_SRC);
  assertStringIncludes(src, "/orders/${orderId}/increment-authorisation");
  assertStringIncludes(src, "const body: Record<string, unknown> = { amount: target };");
  assertStringIncludes(src, "NEW TOTAL authorised amount");
  assertEquals(src.includes("amount: target - previous"), false);
  assertEquals(src.includes("amount: delta"), false);
  assertEquals(src.includes("amount: shortfall"), false);
});

Deno.test("#91 preauth order create uses manual capture + pre_authorisation", async () => {
  const src = await Deno.readTextFile(PREAUTH_SRC);
  assertStringIncludes(src, 'capture_mode: p.captureMode ?? "manual"');
  assertStringIncludes(src, 'authorisation_type: "pre_authorisation"');
});

Deno.test("#91 eligibility requires authorised + manual + card-family methods", () => {
  const base = {
    id: "ord",
    state: "AUTHORISED",
    capture_mode: "manual",
    authorisation_type: "pre_authorisation",
    authorised_amount: 880,
    amount: 880,
    payments: [{ payment_method: { type: "card" }, authorised_amount: 880 }],
  };
  const ok = evaluateRevolutIncrementEligibility({
    order: base,
    targetTotalAuthorisedPence: 903,
    initialAuthorisedPence: 880,
  });
  assertEquals(ok.eligible, true);

  for (const method of ["card", "apple_pay", "google_pay"]) {
    assertEquals(isRevolutIncrementEligiblePaymentMethod(method), true);
  }
  assertEquals(isRevolutIncrementEligiblePaymentMethod("revolut_pay"), false);

  const autoCapture = evaluateRevolutIncrementEligibility({
    order: { ...base, capture_mode: "automatic" },
    targetTotalAuthorisedPence: 903,
    initialAuthorisedPence: 880,
  });
  assertEquals(autoCapture.eligible, false);
  assertEquals(autoCapture.reason, "wrong_capture_mode");
});

Deno.test("#91 provider-confirmed coverage: authorised increment only — not HTTP/processing", () => {
  const processing = classifyIncrementCoverage({
    state: "AUTHORISED",
    incremental_authorisations: [{ state: "processing", new_amount: 1546 }],
    payments: [{ state: "AUTHORISED", authorised_amount: 728 }],
  } as any, 1546);
  assertEquals(processing.class === "confirmed", false);

  const confirmed = classifyIncrementCoverage({
    state: "AUTHORISED",
    incremental_authorisations: [{ state: "authorised", new_amount: 631 }],
    payments: [{ state: "AUTHORISED", authorised_amount: 631 }],
  } as any, 631);
  assertEquals(confirmed.class, "confirmed");
  assertEquals(confirmed.authorisedTotalPence, 631);

  // MK-261120-005 shape: failed increment must not confirm coverage.
  const failed = classifyIncrementCoverage({
    state: "AUTHORISED",
    incremental_authorisations: [{ state: "failed", new_amount: 1546 }],
    payments: [{ state: "AUTHORISED", authorised_amount: 728 }],
  } as any, 1546);
  assertEquals(failed.class === "confirmed", false);
  assertEquals(failed.authorisedTotalPence, 728);
});

Deno.test("#91 business key reuses session+order+target TOTAL (idempotent)", () => {
  assertEquals(
    buildRevolutIncrementBusinessKey({
      paymentSessionId: "94ca4105-c128-49ba-a43e-a7c003e66903",
      providerOrderId: "6b067cd9-d8c1-ae87-8a0f-435dbfc4491f",
      targetTotalAuthorisedPence: 903,
    }),
    "revolut_increment:94ca4105-c128-49ba-a43e-a7c003e66903:6b067cd9-d8c1-ae87-8a0f-435dbfc4491f:903",
  );
});

Deno.test("#91 executeSameOrderIncrement: same order, plain insert, reconcile-before-rePOST", async () => {
  const src = await Deno.readTextFile(EXEC_SRC);
  assertStringIncludes(src, "incrementRevolutOrderAuthorisation");
  assertStringIncludes(src, "targetTotalAuthorisedPence");
  assertStringIncludes(src, "buildRevolutIncrementBusinessKey");
  // Persist then POST — never invent a second order id.
  assertEquals(src.includes("createRevolutOrder"), false);
  assertStringIncludes(src, ".insert(");
  assertEquals(/\.upsert\s*\(/.test(src), false);
  assertStringIncludes(src, "retrieveRevolutOrder");
  assertStringIncludes(src, "INCREMENTING");
});

Deno.test("#91 provider limits constants remain documented", () => {
  assertEquals(REVOLUT_MAX_INCREMENTS_PER_ORDER, 10);
  assertEquals(REVOLUT_MAX_INCREMENT_MULTIPLIER, 5);
});

Deno.test("#91 multiple sequential totals (MK-261125-002 shape: 880→903→935)", () => {
  const first = planRevolutCompletionCapture({
    finalFarePence: 903,
    authorisedHoldPence: 880,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(first.kind, "same_order_increment_required");
  if (first.kind === "same_order_increment_required") {
    assertEquals(first.target_total_authorised_pence, 903);
  }
  const second = planRevolutCompletionCapture({
    finalFarePence: 935,
    authorisedHoldPence: 903,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(second.kind, "same_order_increment_required");
  if (second.kind === "same_order_increment_required") {
    assertEquals(second.target_total_authorised_pence, 935);
  }
});

Deno.test("#91 gate: modification apply only after provider-confirmed coverage", async () => {
  const gate = await Deno.readTextFile(GATE_SRC);
  assertStringIncludes(gate, "PROVIDER_CONFIRMED");
  assertStringIncludes(gate, "Processing/pending/initiated increment new_amount must NOT unlock");
});

Deno.test("#91 failed/declined increment must not invent capture or new order", async () => {
  const exec = await Deno.readTextFile(EXEC_SRC);
  assertStringIncludes(exec, "provider_failed");
  assertStringIncludes(exec, "FAILED_TERMINAL");
  // Capture path still prefers same-order increment — never second preauth.
  const completion = await Deno.readTextFile(COMPLETION_SRC);
  assertStringIncludes(completion, "preferSameOrderIncrement: true");
  assertEquals(completion.includes("create-preauth"), false);
});

Deno.test("#91 Apple Pay / Google Pay / card share increment eligibility contract", () => {
  assertEquals(isRevolutIncrementEligiblePaymentMethod("apple_pay"), true);
  assertEquals(isRevolutIncrementEligiblePaymentMethod("google_pay"), true);
  assertEquals(isRevolutIncrementEligiblePaymentMethod("card"), true);
  assertEquals(isRevolutIncrementEligiblePaymentMethod("APPLE_PAY"), true);
  assertEquals(isRevolutIncrementEligiblePaymentMethod("GOOGLE_PAY"), true);
});

Deno.test("#91 successful increment then capture uses final payable not full hold buffer", () => {
  const plan = planRevolutCompletionCapture({
    finalFarePence: 631,
    authorisedHoldPence: 631,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan.kind, "capture_within_hold");
  if (plan.kind === "capture_within_hold") {
    assertEquals(plan.capture_amount_pence, 631);
  }
});

Deno.test("#91 AUTHORISED is never capture confirmation", () => {
  assertEquals(
    resolveProviderConfirmedCapturePence({
      providerState: "AUTHORISED",
      providerCapturedPence: null,
      sessionStatus: "trip_created",
      sessionCapturedPence: null,
    }),
    0,
  );
  const busy = durableSettlementColumns("capture_busy", false);
  assertEquals(busy.payment_status, "authorized");
});

Deno.test("#91 preserve #89/#90 safeguards in deployed sources", async () => {
  const policy = await Deno.readTextFile(POLICY_SRC);
  assertStringIncludes(policy, "booking_financial_policy");

  const overlap = await Deno.readTextFile(OVERLAP_SRC);
  assertStringIncludes(overlap, "BOOKING_TIME_CONFLICT");

  const completion = await Deno.readTextFile(COMPLETION_SRC);
  assertStringIncludes(completion, "resolveProviderConfirmedCapturePence");
  assertStringIncludes(completion, "reclaimExpiredPaymentSessionFinancialLock");
  assertEquals(
    completion.includes("const confirmedFinalCapturePence = storedTripCapture > 0"),
    false,
  );

  const sweep = await Deno.readTextFile(SWEEP_SRC);
  assertStringIncludes(sweep, "falseLocalCaptured");
  assertStringIncludes(sweep, "reclaimExpiredPaymentSessionFinancialLock");
  assertStringIncludes(sweep, "sweepRecoverMissingTripEarningNet");
  assertStringIncludes(sweep, '"captured"');
});

Deno.test("#91 incrementRevolutOrderAuthorisation rejects target below current", async () => {
  const result = await incrementRevolutOrderAuthorisation({
    environment: "sandbox",
    secretKey: "sk_test",
    orderId: "ord",
    targetTotalAuthorisedPence: 500,
    previousAuthorisedPence: 880,
  });
  assertEquals(result.ok, false);
  assertEquals(result.errorCode, "target_below_current");
  assertEquals(result.apiVersion, "2026-04-20");
});

Deno.test("#91 residual after full capture is zero when capture equals authorised", () => {
  const plan = planRevolutCompletionCapture({
    finalFarePence: 935,
    authorisedHoldPence: 935,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan.kind, "capture_within_hold");
  if (plan.kind === "capture_within_hold") {
    assertEquals(plan.release_remainder_pence, 0);
  }
});
