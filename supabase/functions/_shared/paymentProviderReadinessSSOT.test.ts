import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  resolveAdapterReadinessStatus,
  resolveProviderBookingWorkflow,
} from "./paymentProviderReadinessSSOT.ts";

Deno.test("resolveAdapterReadinessStatus marks live Revolut when credentials ready", () => {
  assertEquals(resolveAdapterReadinessStatus(true, true), "live");
  assertEquals(resolveAdapterReadinessStatus(true, false), "not_configured");
  assertEquals(resolveAdapterReadinessStatus(false, true), "not_implemented");
});

Deno.test("resolveProviderBookingWorkflow maps Revolut when production ready", () => {
  assertEquals(resolveProviderBookingWorkflow("revolut", true), "revolut_merchant");
  assertEquals(resolveProviderBookingWorkflow("revolut", false), "blocked");
  assertEquals(resolveProviderBookingWorkflow("stripe", true), "stripe_preauth");
});
