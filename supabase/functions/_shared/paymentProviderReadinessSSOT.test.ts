import { formatRevolutApiFailure, revolutHttpStatusLabel, revolutMerchantBaseUrl, validateRevolutMerchantSecret } from "./revolutApi.ts";
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  resolveAdapterReadinessStatus,
  resolveProviderBookingWorkflow,
} from "./paymentProviderReadinessSSOT.ts";

Deno.test("revolutHttpStatusLabel maps common HTTP statuses", () => {
  assertEquals(revolutHttpStatusLabel(401), "Unauthorized");
  assertEquals(revolutHttpStatusLabel(403), "Forbidden");
  assertEquals(revolutHttpStatusLabel(404), "Endpoint not found");
  assertEquals(revolutHttpStatusLabel(429), "Rate limited");
});

Deno.test("revolutMerchantBaseUrl uses modern Merchant API path", () => {
  assertEquals(revolutMerchantBaseUrl("live"), "https://merchant.revolut.com/api");
  assertEquals(revolutMerchantBaseUrl("test"), "https://sandbox-merchant.revolut.com/api");
});

Deno.test("validateRevolutMerchantSecret rejects public key in secret field", () => {
  const result = validateRevolutMerchantSecret("pk_test_abc", null);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.message.includes("Public key"), true);
  }
});

Deno.test("formatRevolutApiFailure surfaces HTTP status and Revolut message", () => {
  const formatted = formatRevolutApiFailure(
    {
      status: 401,
      message: "Unauthorized",
      body: { message: "The request should be authorized.", code: "unauthorized" },
    },
    "merchant",
  );
  assertEquals(formatted.http_status, 401);
  assertEquals(formatted.http_status_label, "Unauthorized");
  assertEquals(formatted.revolut_error_code, "unauthorized");
  assertEquals(formatted.api_surface, "merchant");
  assertEquals(formatted.message.includes("401 Unauthorized"), true);
});

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
