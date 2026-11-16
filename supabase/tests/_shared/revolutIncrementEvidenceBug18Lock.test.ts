/**
 * Bug #18 Tier A: incremental authorisation evidence enrichment — allow-list only.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildRevolutIncrementProviderEvidence,
  evidencePayloadLooksSafe,
  providerIncrementOutcome,
  readPaymentMethodBrand,
} from "../../functions/_shared/revolutIncrementEvidenceSSOT.ts";
import type { RevolutOrder } from "../../functions/_shared/revolutOrders.ts";

const declinedOrder: RevolutOrder = {
  id: "6af03d79-157e-a88c-b718-37a3a2bfda20",
  state: "authorised",
  authorisation_type: "pre_authorisation",
  capture_mode: "manual",
  payments: [
    {
      id: "pay_1",
      state: "authorised",
      amount: 500,
      authorised_amount: 500,
      decline_reason: undefined,
      payment_method: Object.assign(
        { type: "card", card_brand: "visa" },
        { last_four: "4242", token: "tok_secret" },
      ),
    },
  ],
  incremental_authorisations: [
    {
      id: "inc_abc",
      old_amount: 500,
      new_amount: 1216,
      state: "declined",
      reason: undefined,
      created_at: "2026-11-08T09:30:10.000Z",
      reference: "revolut_increment:sess:order:1216",
    },
  ],
};

Deno.test("Bug #18 Tier A: evidence captures method, brand, delta, order id, after-decline status", () => {
  const evidence = buildRevolutIncrementProviderEvidence({
    order: declinedOrder,
    evidenceSource: "retrieve",
    reference: "revolut_increment:sess:order:1216",
    targetTotalPence: 1216,
    previousAuthorisedTotalPence: 500,
    providerAuthorisedTotalPence: 500,
    providerOrderId: "6af03d79-157e-a88c-b718-37a3a2bfda20",
    paymentMethodType: "card",
    requestStartedAtIso: "2026-11-08T09:30:08.000Z",
    postHttpOk: true,
    nowIso: "2026-11-08T09:30:10.430Z",
  });

  assertEquals(evidence.provider_order_id, "6af03d79-157e-a88c-b718-37a3a2bfda20");
  assertEquals(evidence.increment_request_reference, "revolut_increment:sess:order:1216");
  assertEquals(evidence.previous_authorised_total_pence, 500);
  assertEquals(evidence.requested_target_total_pence, 1216);
  assertEquals(evidence.requested_increment_delta_pence, 716);
  assertEquals(evidence.payment_method_type, "card");
  assertEquals(evidence.card_brand, "visa");
  assertEquals(evidence.increment_state, "declined");
  assertEquals(evidence.increment_reason, null);
  assertEquals(evidence.processing_outcome, "declined");
  assertEquals(evidence.order_state, "authorised");
  assertEquals(evidence.authorisation_type, "pre_authorisation");
  assertEquals(evidence.capture_mode, "manual");
  assertEquals(evidence.provider_authorised_total_pence, 500);
  assertEquals(evidence.request_started_at, "2026-11-08T09:30:08.000Z");
  assertEquals(evidence.response_completed_at, "2026-11-08T09:30:10.430Z");
  assertStringIncludes(
    String(evidence.original_authorisation_status_after_attempt),
    "authorised",
  );
  assertStringIncludes(
    String(evidence.original_authorisation_status_after_attempt),
    "authorised_total_pence=500",
  );
  assertEquals(providerIncrementOutcome(evidence), "declined");
  assertEquals(evidencePayloadLooksSafe(evidence), true);
});

Deno.test("Bug #18 Tier A: never copies last_four or token into evidence", () => {
  const evidence = buildRevolutIncrementProviderEvidence({
    order: declinedOrder,
    evidenceSource: "retrieve",
    reference: "revolut_increment:sess:order:1216",
    targetTotalPence: 1216,
    previousAuthorisedTotalPence: 500,
    providerAuthorisedTotalPence: 500,
    providerOrderId: declinedOrder.id,
  });
  const raw = JSON.stringify(evidence).toLowerCase();
  assertEquals(raw.includes("4242"), false);
  assertEquals(raw.includes("last_four"), false);
  assertEquals(raw.includes("tok_secret"), false);
  assertEquals(raw.includes("token"), false);
});

Deno.test("Bug #18 Tier A: brand reader ignores toxic nested fields", () => {
  assertEquals(
    readPaymentMethodBrand({ type: "apple_pay", brand: "mastercard", last_four: "9999" }),
    "mastercard",
  );
});

Deno.test("Bug #18 Tier A: executeSameOrderIncrement persists enriched flat metadata keys", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/executeSameOrderIncrementSSOT.ts", import.meta.url),
  );
  assertStringIncludes(src, "paymentMethodType:");
  assertStringIncludes(src, "providerOrderId: orderId");
  assertStringIncludes(src, "requestStartedAtIso");
  assertStringIncludes(src, "requested_increment_delta_pence");
  assertStringIncludes(src, "original_authorisation_status_after_attempt");
  assertStringIncludes(src, "card_brand");
  // Must not reintroduce second-order / buffer / fallback policy in this file for Tier A.
  assertEquals(src.includes("allowControlledFallback: true"), false);
});
