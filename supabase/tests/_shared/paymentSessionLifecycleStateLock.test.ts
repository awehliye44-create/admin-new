/**
 * Lock — canonical lifecycle provider-state normalize + PAYMENT_FAILED alignment.
 *
 * Run:
 *   deno test --allow-read supabase/tests/_shared/paymentSessionLifecycleStateLock.test.ts
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isCanonicalAuthorisedOrCaptured,
  isCanonicalTerminalNegative,
  normalizeLifecycleProviderState,
  terminalNegativeSessionStatus,
} from "../../functions/_shared/paymentSessionLifecycleStateSSOT.ts";
import {
  isRevolutProviderStateRegression,
  revolutProviderStateRank,
} from "../../functions/_shared/revolutProviderStateRankSSOT.ts";
import { resolvePaymentSessionStatusFromProviderWebhook } from "../../functions/_shared/paymentSessionWebhookLifecycleResolver.ts";
import { mapSavedCardProviderOrderToReconcileState } from "../../functions/_shared/savedCardPaymentReconcileSSOT.ts";

Deno.test("normalize: ORDER_PAYMENT_FAILED / PAYMENT_FAILED → FAILED", () => {
  assertEquals(normalizeLifecycleProviderState("ORDER_PAYMENT_FAILED"), "FAILED");
  assertEquals(normalizeLifecycleProviderState("PAYMENT_FAILED"), "FAILED");
  assertEquals(normalizeLifecycleProviderState("failed"), "FAILED");
});

Deno.test("normalize: DECLINED / CANCELLED / AUTHORISED / PROCESSING synonyms", () => {
  assertEquals(normalizeLifecycleProviderState("ORDER_PAYMENT_DECLINED"), "DECLINED");
  assertEquals(normalizeLifecycleProviderState("DECLINED"), "DECLINED");
  assertEquals(normalizeLifecycleProviderState("CANCELED"), "CANCELLED");
  assertEquals(normalizeLifecycleProviderState("AUTHORIZED"), "AUTHORISED");
  assertEquals(normalizeLifecycleProviderState("PENDING"), "PROCESSING");
  assertEquals(normalizeLifecycleProviderState("PAYMENT_PROCESSING"), "PROCESSING");
  assertEquals(
    normalizeLifecycleProviderState("AUTHENTICATION_CHALLENGE"),
    "AUTHENTICATION_CHALLENGE",
  );
});

Deno.test("terminalNegativeSessionStatus: FAILED/DECLINED → failed; CANCELLED → cancelled", () => {
  assertEquals(terminalNegativeSessionStatus("PAYMENT_FAILED"), "failed");
  assertEquals(terminalNegativeSessionStatus("DECLINED"), "failed");
  assertEquals(terminalNegativeSessionStatus("CANCELLED"), "cancelled");
  assert(isCanonicalTerminalNegative("PAYMENT_FAILED"));
  assert(isCanonicalAuthorisedOrCaptured("AUTHORIZED"));
});

Deno.test("rank: PAYMENT_FAILED and DECLINED match FAILED (10)", () => {
  assertEquals(revolutProviderStateRank("PAYMENT_FAILED"), 10);
  assertEquals(revolutProviderStateRank("DECLINED"), 10);
  assertEquals(revolutProviderStateRank("FAILED"), 10);
  assertEquals(revolutProviderStateRank("PENDING"), revolutProviderStateRank("PROCESSING"));
});

Deno.test("1) order PENDING + payment FAILED → session failed (mapper + lifecycle)", () => {
  const m = mapSavedCardProviderOrderToReconcileState({
    id: "ord-1",
    state: "PENDING",
    payments: [{ id: "p1", state: "FAILED", decline_reason: "technical_error" }],
  });
  assertEquals(m.lifecycle_provider_state, "FAILED");
  assertEquals(m.client_state, "PAYMENT_FAILED");
  assertEquals(m.terminal, true);

  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "pending_payment",
    providerState: m.lifecycle_provider_state,
    purpose: "RIDE_BOOKING",
  });
  assertEquals(r.decision, "ADVANCE");
  assertEquals(r.nextStatus, "failed");
});

Deno.test("2) technical_error preserved — preserve_saved_card true", () => {
  const m = mapSavedCardProviderOrderToReconcileState({
    id: "ord-1",
    state: "PENDING",
    payments: [{ id: "p1", state: "FAILED", decline_reason: "technical_error" }],
  });
  assertEquals(m.preserve_saved_card, true);
  assert(m.failure_reason?.includes("technical_error"));
});

Deno.test("3) webhook duplicate PAYMENT_FAILED/FAILED is idempotent", () => {
  for (const providerState of ["PAYMENT_FAILED", "FAILED", "ORDER_PAYMENT_FAILED"]) {
    const r = resolvePaymentSessionStatusFromProviderWebhook({
      currentStatus: "failed",
      providerState,
      purpose: "RIDE_BOOKING",
      priorProviderState: "FAILED",
    });
    assertEquals(r.decision, "KEEP_CURRENT");
    assertEquals(r.reason, "terminal_negative_idempotent");
  }
});

Deno.test("4) webhook absent + reconcile path → same terminal result (mapper unit)", () => {
  const m = mapSavedCardProviderOrderToReconcileState({
    id: "ord-1",
    state: "pending",
    payments: [{ id: "p1", state: "failed", decline_reason: "technical_error" }],
  });
  assertEquals(m.lifecycle_provider_state, "FAILED");
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "pending_payment",
    providerState: m.lifecycle_provider_state,
    purpose: "RIDE_BOOKING",
  });
  assertEquals(r.nextStatus, "failed");
});

Deno.test("5) late webhook after reconcile (status already failed) → KEEP_CURRENT", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "failed",
    providerState: "PAYMENT_FAILED",
    purpose: "RIDE_BOOKING",
    priorProviderState: "FAILED",
  });
  assertEquals(r.decision, "KEEP_CURRENT");
  assertEquals(r.nextStatus, undefined);
});

Deno.test("6) FAILED cannot create trip — lifecycle does not advance to authorised", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "pending_payment",
    providerState: "PAYMENT_FAILED",
    purpose: "RIDE_BOOKING",
  });
  assertEquals(r.decision, "ADVANCE");
  assertEquals(r.nextStatus, "failed");
  assert(r.nextStatus !== "trip_created");
  assert(r.nextStatus !== "payment_authorised");
});

Deno.test("7) FAILED cannot regress to processing", () => {
  assertEquals(
    isRevolutProviderStateRegression("FAILED", "PROCESSING"),
    true,
  );
  assertEquals(
    isRevolutProviderStateRegression("PAYMENT_FAILED", "PENDING"),
    true,
  );
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "failed",
    providerState: "PROCESSING",
    purpose: "RIDE_BOOKING",
    priorProviderState: "FAILED",
  });
  assertEquals(r.decision, "KEEP_CURRENT");
  assertEquals(r.nextStatus, undefined);
});

Deno.test("8) AUTHORISED cannot regress from later failed observation", () => {
  assertEquals(isRevolutProviderStateRegression("AUTHORISED", "FAILED"), true);
  assertEquals(isRevolutProviderStateRegression("AUTHORISED", "PAYMENT_FAILED"), true);
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "payment_authorised",
    providerState: "PAYMENT_FAILED",
    purpose: "RIDE_BOOKING",
    priorProviderState: "AUTHORISED",
  });
  assertEquals(r.decision, "KEEP_CURRENT");
  assertEquals(r.reason, "late_terminal_negative_after_authorised_provider_state");
});

Deno.test("raw PAYMENT_FAILED input to lifecycle → ADVANCE failed from pending_payment", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "pending_payment",
    providerState: "PAYMENT_FAILED",
    purpose: "RIDE_BOOKING",
  });
  assertEquals(r.decision, "ADVANCE");
  assertEquals(r.nextStatus, "failed");
  assertEquals(r.reason, "pre_capture_terminal_negative");
});

Deno.test("DECLINED advances pending_payment → failed", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "pending_payment",
    providerState: "DECLINED",
    purpose: "RIDE_BOOKING",
  });
  assertEquals(r.decision, "ADVANCE");
  assertEquals(r.nextStatus, "failed");
});

Deno.test("AUTHENTICATION_CHALLENGE does not advance to failed", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "pending_payment",
    providerState: "AUTHENTICATION_CHALLENGE",
    purpose: "RIDE_BOOKING",
  });
  assertEquals(r.decision, "KEEP_CURRENT");
  assertEquals(r.nextStatus, undefined);
});

Deno.test("10) no card invalidation for technical_error (mapper preserve)", () => {
  const m = mapSavedCardProviderOrderToReconcileState({
    id: "ord-1",
    state: "PENDING",
    payments: [{ id: "p1", state: "DECLINED", decline_reason: "technical_error" }],
  });
  assertEquals(m.preserve_saved_card, true);
  // technical keeps client PAYMENT_FAILED + lifecycle FAILED (not DECLINED invalidate path)
  assertEquals(m.client_state, "PAYMENT_FAILED");
  assertEquals(m.lifecycle_provider_state, "FAILED");
});

Deno.test("mapper lifecycle_provider_state never emits PAYMENT_FAILED", () => {
  const m = mapSavedCardProviderOrderToReconcileState({
    id: "ord-1",
    state: "PENDING",
    payments: [{ id: "p1", state: "FAILED" }],
  });
  assertEquals(m.lifecycle_provider_state, "FAILED");
  assert(m.lifecycle_provider_state !== "PAYMENT_FAILED");

  const inFlight = mapSavedCardProviderOrderToReconcileState({
    id: "ord-1",
    state: "PENDING",
    payments: [],
  });
  assertEquals(inFlight.lifecycle_provider_state, "PROCESSING");
});

Deno.test("webhook source: always normalize + broaden enrich gate", async () => {
  const webhookSrc = await Deno.readTextFile(
    new URL("../../functions/revolut-webhook/index.ts", import.meta.url),
  );
  assert(webhookSrc.includes("normalizeLifecycleProviderState"));
  assert(webhookSrc.includes("shouldEnrichPayments"));
  assert(webhookSrc.includes("ORDER_PAYMENT_"));
  assert(webhookSrc.includes("mapping.lifecycle_provider_state"));
  assert(webhookSrc.includes("mappingFailureReason"));
});
