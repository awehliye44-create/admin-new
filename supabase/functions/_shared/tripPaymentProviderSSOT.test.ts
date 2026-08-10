import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  looksLikeProviderPaymentIntentId,
  resolveTripPaymentProvider,
  tripProviderOrderId,
  tripProviderPaymentIntentId,
} from "./tripPaymentProviderSSOT.ts";

Deno.test("resolveTripPaymentProvider prefers explicit payment_provider", () => {
  assertEquals(resolveTripPaymentProvider({ payment_provider: "revolut", provider_payment_id: "pi_x" }), "revolut");
  assertEquals(resolveTripPaymentProvider({ payment_provider: "stripe", provider_order_id: "ord_x" }), "stripe");
});

Deno.test("resolveTripPaymentProvider infers from refs", () => {
  assertEquals(resolveTripPaymentProvider({ provider_payment_id: "pi_abc" }), "stripe");
  assertEquals(resolveTripPaymentProvider({ provider_order_id: "ord_abc" }), "revolut");
});

Deno.test("tripProviderOrderId and tripProviderPaymentIntentId", () => {
  assertEquals(tripProviderPaymentIntentId({ provider_payment_id: "pi_1" }), "pi_1");
  assertEquals(tripProviderPaymentIntentId({ provider_payment_id: "ord_1" }), null);
  assertEquals(tripProviderOrderId({ provider_order_id: "ord_1" }), "ord_1");
});

Deno.test("looksLikeProviderPaymentIntentId", () => {
  assertEquals(looksLikeProviderPaymentIntentId("pi_x"), true);
  assertEquals(looksLikeProviderPaymentIntentId("ord_x"), false);
});
