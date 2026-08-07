import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  looksLikeStripePaymentIntentId,
  resolveTripPaymentProvider,
  tripProviderOrderId,
  tripStripePaymentIntentId,
} from "./tripPaymentProviderSSOT.ts";

Deno.test("resolveTripPaymentProvider prefers explicit revolut", () => {
  assertEquals(resolveTripPaymentProvider({ payment_provider: "revolut", stripe_payment_intent_id: "pi_x" }), "revolut");
  assertEquals(resolveTripPaymentProvider({ payment_provider: "stripe", provider_order_id: "ord_x" }), "legacy_stripe");
});

Deno.test("resolveTripPaymentProvider infers Revolut from provider_order_id only", () => {
  assertEquals(resolveTripPaymentProvider({ provider_order_id: "ord_abc" }), "revolut");
  assertEquals(resolveTripPaymentProvider({ payment_session_id: "ps_abc" }), "revolut");
  assertEquals(resolveTripPaymentProvider({ stripe_payment_intent_id: "pi_abc" }), "unknown");
  assertEquals(resolveTripPaymentProvider({}), "unknown");
});

Deno.test("tripProviderOrderId ignores Stripe PI; tripStripePaymentIntentId retired", () => {
  assertEquals(tripStripePaymentIntentId({ stripe_payment_intent_id: "pi_1" }), null);
  assertEquals(tripProviderOrderId({ provider_order_id: "ord_1" }), "ord_1");
  assertEquals(tripProviderOrderId({ stripe_payment_intent_id: "legacy-ord" }), null);
  assertEquals(tripProviderOrderId({ stripe_payment_intent_id: "pi_1" }), null);
});

Deno.test("looksLikeStripePaymentIntentId", () => {
  assertEquals(looksLikeStripePaymentIntentId("pi_x"), true);
  assertEquals(looksLikeStripePaymentIntentId("ord_x"), false);
});
