/**
 * Lock — saved-card payment reconcile mapper + handoff + throttle.
 *
 * Run:
 *   deno test --allow-read supabase/tests/_shared/savedCardPaymentReconcileLock.test.ts
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildSavedCardPendingHandoff,
  buildSavedCardReconcileToken,
  computeTerminalFailureRetryAfterMs,
  isTechnicalDeclineReason,
  mapSavedCardProviderOrderToReconcileState,
  SAVED_CARD_TERMINAL_FAILURE_THROTTLE_MS,
  verifySavedCardReconcileToken,
} from "../../functions/_shared/savedCardPaymentReconcileSSOT.ts";
import { resolvePaymentSessionStatusFromProviderWebhook } from "../../functions/_shared/paymentSessionWebhookLifecycleResolver.ts";

const PREAUTH = Deno.readTextFileSync(
  new URL("../../functions/_shared/revolutPreauth.ts", import.meta.url),
);
const WEBHOOK = Deno.readTextFileSync(
  new URL("../../functions/revolut-webhook/index.ts", import.meta.url),
);
const CONFIRM = Deno.readTextFileSync(
  new URL("../../functions/confirm-revolut-payment/index.ts", import.meta.url),
);
const RECONCILE_EDGE = Deno.readTextFileSync(
  new URL("../../functions/reconcile-payment-session/index.ts", import.meta.url),
);

Deno.test("order PENDING + payment FAILED technical_error → PAYMENT_FAILED", () => {
  const m = mapSavedCardProviderOrderToReconcileState({
    id: "6aacda83-592f-abc8-a53d-34d535c2a505",
    state: "pending",
    payments: [{
      id: "6aacda83-8a68-xxxx",
      state: "failed",
      decline_reason: "technical_error",
    }],
  });
  assertEquals(m.client_state, "PAYMENT_FAILED");
  assertEquals(m.lifecycle_provider_state, "FAILED");
  assertEquals(m.terminal, true);
  assertEquals(m.preserve_saved_card, true);
  assert(m.failure_reason?.includes("technical_error"));
});

Deno.test("order PENDING + payment FAILED bank decline → DECLINED, may invalidate", () => {
  const m = mapSavedCardProviderOrderToReconcileState({
    id: "order-1",
    state: "PENDING",
    payments: [{ id: "p1", state: "DECLINED", decline_reason: "insufficient_funds" }],
  });
  assertEquals(m.client_state, "DECLINED");
  assertEquals(m.terminal, true);
  assertEquals(m.preserve_saved_card, false);
});

Deno.test("order AUTHORISED → AUTHORISED", () => {
  const m = mapSavedCardProviderOrderToReconcileState({
    id: "order-1",
    state: "AUTHORISED",
    payments: [{ id: "p1", state: "AUTHORISED" }],
  });
  assertEquals(m.client_state, "AUTHORISED");
  assertEquals(m.terminal, false);
});

Deno.test("payment authentication_challenge → CUSTOMER_ACTION_REQUIRED", () => {
  const m = mapSavedCardProviderOrderToReconcileState({
    id: "order-1",
    state: "PENDING",
    payments: [{
      id: "p1",
      state: "authentication_challenge",
      authentication_challenge: { acs_url: "https://acs.example/challenge" },
    }],
  });
  assertEquals(m.client_state, "CUSTOMER_ACTION_REQUIRED");
  assertEquals(m.acs_url, "https://acs.example/challenge");
  assertEquals(m.terminal, false);
});

Deno.test("order PENDING no payment → PAYMENT_PROCESSING", () => {
  const m = mapSavedCardProviderOrderToReconcileState({
    id: "order-1",
    state: "PENDING",
    payments: [],
  });
  assertEquals(m.client_state, "PAYMENT_PROCESSING");
  assertEquals(m.terminal, false);
});

Deno.test("lifecycle resolver: FAILED advances pending_payment → failed", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "pending_payment",
    providerState: "FAILED",
    purpose: "RIDE_BOOKING",
  });
  assertEquals(r.decision, "ADVANCE");
  assertEquals(r.nextStatus, "failed");
});

Deno.test("lifecycle resolver: FAILED is idempotent on already failed", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "failed",
    providerState: "FAILED",
    purpose: "RIDE_BOOKING",
  });
  assertEquals(r.decision, "KEEP_CURRENT");
  assertEquals(r.reason, "terminal_negative_idempotent");
});

Deno.test("reconcile token is stable and secret-free", () => {
  const args = {
    paymentSessionId: "8e3551f5-08ef-4cfa-8e26-e589a3c7dccc",
    clientActionId: "fc8ab9be-8285-45cf-83cb-f58be591d641",
    providerOrderId: "6aacda83-592f-abc8-a53d-34d535c2a505",
  };
  const t1 = buildSavedCardReconcileToken(args);
  const t2 = buildSavedCardReconcileToken(args);
  assertEquals(t1, t2);
  assert(t1.startsWith("scr_"));
  assert(!t1.includes("sk_"));
  assert(!t1.includes("pk_"));
  assert(verifySavedCardReconcileToken(t1, args));
  assert(!verifySavedCardReconcileToken("scr_tampered", args));
});

Deno.test("saved_card_pending handoff includes stable IDs", () => {
  const h = buildSavedCardPendingHandoff({
    paymentSessionId: "8e3551f5-08ef-4cfa-8e26-e589a3c7dccc",
    clientActionId: "fc8ab9be-8285-45cf-83cb-f58be591d641",
    providerOrderId: "6aacda83-592f-abc8-a53d-34d535c2a505",
    providerPaymentId: "pay-1",
  });
  assertEquals(h.code, "saved_card_pending");
  assertEquals(h.payment_session_id, "8e3551f5-08ef-4cfa-8e26-e589a3c7dccc");
  assertEquals(h.client_action_id, "fc8ab9be-8285-45cf-83cb-f58be591d641");
  assertEquals(h.booking_attempt_id, "fc8ab9be-8285-45cf-83cb-f58be591d641");
  assertEquals(h.provider_order_id, "6aacda83-592f-abc8-a53d-34d535c2a505");
  assert(typeof h.reconcile_token === "string");
  assertEquals(h.client_state, "PAYMENT_PROCESSING");
});

Deno.test("terminal failure throttle is bounded at 30s", () => {
  assertEquals(SAVED_CARD_TERMINAL_FAILURE_THROTTLE_MS, 30_000);
  const now = Date.parse("2026-09-18T07:00:00Z");
  const remaining = computeTerminalFailureRetryAfterMs({
    failedAtIso: "2026-09-18T06:59:45Z",
    nowMs: now,
  });
  assertEquals(remaining, 15_000);
  const done = computeTerminalFailureRetryAfterMs({
    failedAtIso: "2026-09-18T06:59:00Z",
    nowMs: now,
  });
  assertEquals(done, 0);
});

Deno.test("isTechnicalDeclineReason covers technical_error", () => {
  assert(isTechnicalDeclineReason("technical_error"));
  assert(isTechnicalDeclineReason("TECHNICAL_ERROR"));
  assert(!isTechnicalDeclineReason("insufficient_funds"));
});

Deno.test("create-preauth source: pending handoff + no invalidate on technical", () => {
  assert(PREAUTH.includes("buildSavedCardPendingHandoff"));
  assert(PREAUTH.includes("isTechnicalDeclineReason"));
  assert(PREAUTH.includes("markPaymentSessionFailed"));
  assert(PREAUTH.includes("preserveSavedCard"));
  assert(PREAUTH.includes("PAYMENT_PROCESSING"));
  // technical path must skip invalidate
  assert(PREAUTH.includes("if (!preserveCard)"));
  assert(PREAUTH.includes("invalidateRevolutProviderToken"));
});

Deno.test("webhook source: payment-level enrich + shared mapper", () => {
  assert(WEBHOOK.includes("mapSavedCardProviderOrderToReconcileState"));
  assert(WEBHOOK.includes("payment-level terminal overrides order state"));
  assert(WEBHOOK.includes("listRevolutOrderPayments"));
  assert(WEBHOOK.includes("effectiveStateUpper"));
});

Deno.test("confirm-revolut source: shared mapper + terminalize session", () => {
  assert(CONFIRM.includes("mapSavedCardProviderOrderToReconcileState"));
  assert(CONFIRM.includes("applySavedCardOrderReconcile"));
  assert(CONFIRM.includes("client_state"));
  assert(CONFIRM.includes("no_new_order"));
});

Deno.test("reconcile-payment-session: auth + no new order + mockable retrieve", () => {
  assert(RECONCILE_EDGE.includes("retrieveAndReconcileSavedCardSession"));
  assert(RECONCILE_EDGE.includes("no_new_order"));
  assert(RECONCILE_EDGE.includes("Unauthorized"));
  assert(RECONCILE_EDGE.includes("listRevolutOrderPayments"));
  assert(!RECONCILE_EDGE.includes("createRevolutOrder"));
  assert(!RECONCILE_EDGE.includes("payRevolutOrderWithSavedCard"));
});

Deno.test("TRY AGAIN no new order — preauth handoff exposes client_action_id", () => {
  assert(PREAUTH.includes("client_action_id: args.clientActionId"));
  assert(PREAUTH.includes("reconcile_token") || PREAUTH.includes("buildSavedCardPendingHandoff"));
});
