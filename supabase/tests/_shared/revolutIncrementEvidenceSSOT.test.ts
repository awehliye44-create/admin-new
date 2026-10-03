import { assertEquals, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildIncrementWebhookEventId,
  buildRevolutIncrementProviderEvidence,
  findIncrementAttempt,
  findIncrementForWebhook,
  isRevolutIncrementWebhookEvent,
  providerIncrementOutcome,
  readIncrementProviderReason,
} from "../../functions/_shared/revolutIncrementEvidenceSSOT.ts";
import type { RevolutOrder } from "../../functions/_shared/revolutOrders.ts";

const REF = "inc:sess:ord:800";

function order(increments: Array<Record<string, unknown>>, paymentExtra: Record<string, unknown> = {}): RevolutOrder {
  return {
    id: "ord_1",
    state: "AUTHORISED",
    amount: 500,
    currency: "GBP",
    payments: [{
      id: "pay_1",
      state: "AUTHORISED",
      amount: 500,
      authorised_amount: 500,
      payment_method: {
        type: "card",
        card_brand: "visa",
        card_last_four: "4242",
        card_bin: "424242",
        card_expiry: "12/30",
        cardholder_name: "Test Holder",
        token: "tok_secret_should_never_persist",
      },
      ...paymentExtra,
    }],
    incremental_authorisations: increments,
  } as unknown as RevolutOrder;
}

Deno.test("reason: documented `reason` field is read first", () => {
  assertEquals(readIncrementProviderReason({ state: "declined", reason: "do_not_honour", decline_reason: "legacy" }), {
    reason: "do_not_honour",
    field: "reason",
  });
});

Deno.test("reason: `decline_reason` only as backward-compatible fallback", () => {
  assertEquals(readIncrementProviderReason({ state: "declined", decline_reason: "legacy_code" }), {
    reason: "legacy_code",
    field: "decline_reason",
  });
});

Deno.test("reason: missing reason stays null (never invented)", () => {
  assertEquals(readIncrementProviderReason({ state: "declined" }), { reason: null, field: null });
  assertEquals(readIncrementProviderReason({ state: "declined", reason: "" }), { reason: null, field: null });
  assertEquals(readIncrementProviderReason({ state: "declined", reason: { nested: "blob" } }), { reason: null, field: null });
});

Deno.test("reason: control characters stripped, length bounded", () => {
  const r = readIncrementProviderReason({ reason: `bad\u0000\nreason${"x".repeat(500)}` });
  assertStrictEquals(r.reason!.includes("\u0000"), false);
  assertStrictEquals(r.reason!.includes("\n"), false);
  assertStrictEquals(r.reason!.length <= 200, true);
});

Deno.test("attempt match: reference beats amount beats latest", () => {
  const o = order([
    { state: "declined", reason: "a", new_amount: 800, reference: REF },
    { state: "authorised", new_amount: 800, reference: "other" },
    { state: "failed", reason: "c", new_amount: 900 },
  ]);
  assertEquals(findIncrementAttempt(o, { reference: REF, targetTotalPence: 800 }).matchedBy, "reference");
  assertEquals(findIncrementAttempt(o, { reference: REF, targetTotalPence: 800 }).entry?.reason, "a");
  const byAmount = findIncrementAttempt(o, { reference: "missing", targetTotalPence: 800 });
  assertEquals(byAmount.matchedBy, "target_amount");
  assertEquals(byAmount.entry?.reference, "other");
  assertEquals(findIncrementAttempt(o, { targetTotalPence: 1234 }).matchedBy, "latest");
  assertEquals(findIncrementAttempt(order([]), { reference: REF }).matchedBy, null);
});

Deno.test("evidence: declined keeps provider reason, old/new amounts and unchanged authorised amount", () => {
  const e = buildRevolutIncrementProviderEvidence({
    order: order(
      [{ state: "declined", reason: "insufficient_funds", old_amount: 500, new_amount: 800, reference: REF }],
      { decline_reason: "payment_level_reason" },
    ),
    evidenceSource: "retrieve",
    reference: REF,
    targetTotalPence: 800,
    previousAuthorisedTotalPence: 500,
    providerAuthorisedTotalPence: 500,
    postHttpStatus: null,
    postHttpOk: true,
    nowIso: "2026-10-02T00:00:00.000Z",
  });
  assertEquals(e.increment_state, "declined");
  assertEquals(e.increment_reason, "insufficient_funds");
  assertEquals(e.increment_reason_field, "reason");
  assertEquals(e.increment_old_amount_pence, 500);
  assertEquals(e.increment_new_amount_pence, 800);
  assertEquals(e.increment_reference, REF);
  assertEquals(e.requested_target_total_pence, 800);
  assertEquals(e.previous_authorised_total_pence, 500);
  assertEquals(e.payment_state, "AUTHORISED");
  assertEquals(e.payment_authorised_amount_pence, 500);
  assertEquals(e.payment_decline_reason, "payment_level_reason");
  assertEquals(e.order_state, "AUTHORISED");
  assertEquals(e.provider_authorised_total_pence, 500);
  assertEquals(providerIncrementOutcome(e), "declined");
});

Deno.test("evidence: never contains card details, payment method objects or tokens", () => {
  const e = buildRevolutIncrementProviderEvidence({
    order: order([{ state: "failed", reason: "technical_error", new_amount: 800, reference: REF }]),
    evidenceSource: "retrieve",
    reference: REF,
    targetTotalPence: 800,
  });
  const json = JSON.stringify(e);
  for (const forbidden of ["4242", "424242", "12/30", "Test Holder", "tok_secret", "payment_method", "card_"]) {
    assertStrictEquals(json.includes(forbidden), false, `evidence leaked ${forbidden}`);
  }
});

Deno.test("outcome: failed is distinct from declined", () => {
  const failed = buildRevolutIncrementProviderEvidence({
    order: order([{ state: "failed", reason: "technical_error", new_amount: 800, reference: REF }]),
    evidenceSource: "retrieve",
    reference: REF,
  });
  assertEquals(providerIncrementOutcome(failed), "failed");
  assertEquals(providerIncrementOutcome({ increment_state: "authorised" }), "authorised");
  assertEquals(providerIncrementOutcome({ increment_state: "processing" }), "unsettled");
  assertEquals(providerIncrementOutcome({ increment_state: null }), "unknown");
});

Deno.test("webhook: event recognition and entry selection by state", () => {
  assertEquals(isRevolutIncrementWebhookEvent("ORDER_INCREMENTAL_AUTHORISATION_DECLINED"), true);
  assertEquals(isRevolutIncrementWebhookEvent("ORDER_AUTHORISED"), false);
  const o = order([
    { state: "declined", reason: "a", new_amount: 700, reference: "r1" },
    { state: "authorised", new_amount: 800, reference: "r2" },
  ]);
  const declined = findIncrementForWebhook(o, "ORDER_INCREMENTAL_AUTHORISATION_DECLINED");
  assertEquals(declined.entry?.reference, "r1");
  assertEquals(declined.stateMatchesEvent, true);
  const failed = findIncrementForWebhook(o, "ORDER_INCREMENTAL_AUTHORISATION_FAILED");
  assertEquals(failed.entry?.reference, "r2");
  assertEquals(failed.stateMatchesEvent, false);
});

Deno.test("webhook: event id is stable per event+order+attempt+state", () => {
  const a = buildIncrementWebhookEventId({
    eventName: "ORDER_INCREMENTAL_AUTHORISATION_DECLINED",
    orderId: "ord_1",
    incrementReference: REF,
    incrementState: "declined",
    requestTimestamp: "1",
  });
  const b = buildIncrementWebhookEventId({
    eventName: "ORDER_INCREMENTAL_AUTHORISATION_DECLINED",
    orderId: "ord_1",
    incrementReference: REF,
    incrementState: "declined",
    requestTimestamp: "2",
  });
  assertEquals(a, b);
  const lagging = buildIncrementWebhookEventId({
    eventName: "ORDER_INCREMENTAL_AUTHORISATION_DECLINED",
    orderId: "ord_1",
    incrementReference: REF,
    incrementState: "processing",
  });
  assertStrictEquals(lagging === a, false);
  const byAmount = buildIncrementWebhookEventId({
    eventName: "ORDER_INCREMENTAL_AUTHORISATION_FAILED",
    orderId: "ord_1",
    incrementNewAmountPence: 800,
    incrementState: "failed",
  });
  assertEquals(byAmount, "revolut_increment_webhook:ORDER_INCREMENTAL_AUTHORISATION_FAILED:ord_1:amount:800:failed");
  const unresolved = buildIncrementWebhookEventId({
    eventName: "ORDER_INCREMENTAL_AUTHORISATION_FAILED",
    orderId: "ord_1",
    requestTimestamp: "1700000000",
  });
  assertEquals(unresolved, "revolut_increment_webhook:ORDER_INCREMENTAL_AUTHORISATION_FAILED:ord_1:unresolved:1700000000");
});
