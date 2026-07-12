import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isStripeRuntimeDisabled,
  resolveActivePaymentProviderName,
  resolveActivePayoutProviderName,
  classifyLegacyStripeEvidence,
  LEGACY_STRIPE_EVIDENCE,
  STRIPE_RETIRED,
} from "./stripeRuntimeDisabled.ts";

Deno.test("gap: admin resolvers never return stripe", () => {
  assertEquals(resolveActivePaymentProviderName("stripe"), "unavailable");
  assertEquals(resolveActivePaymentProviderName(null), "unavailable");
  assertEquals(resolveActivePayoutProviderName("stripe"), "unavailable");
  assertEquals(resolveActivePayoutProviderName("bank_transfer"), "bank_transfer");
});

Deno.test("gap: legacy evidence preserved label", () => {
  assertEquals(classifyLegacyStripeEvidence("stripe"), LEGACY_STRIPE_EVIDENCE);
  assertEquals(isStripeRuntimeDisabled(() => undefined), true);
  assertEquals(STRIPE_RETIRED, "STRIPE_RETIRED");
});
