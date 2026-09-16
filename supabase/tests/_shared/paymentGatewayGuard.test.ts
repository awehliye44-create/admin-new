import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  assertGatewayExecutable,
  PAYMENT_GATEWAY_NOT_CONFIGURED,
  type GatewayConfiguredResult,
} from "./paymentGatewayGuard.ts";

const providerOk: GatewayConfiguredResult = {
  ok: true,
  provider: "provider",
  environment: "live",
  display_name: "provider",
  role: "customer",
};

Deno.test("assertGatewayExecutable allows provider", () => {
  assertEquals(assertGatewayExecutable(providerOk), providerOk);
});

Deno.test("assertGatewayExecutable blocks non-provider until live adapters exist", () => {
  const paystack: GatewayConfiguredResult = {
    ok: true,
    provider: "paystack",
    environment: "test",
    display_name: "Paystack",
    role: "customer",
  };
  const result = assertGatewayExecutable(paystack);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.code, PAYMENT_GATEWAY_NOT_CONFIGURED);
    assertEquals(result.provider, "paystack");
    assertEquals(result.role, "customer");
  }
});

Deno.test("assertGatewayExecutable passes through not-configured checks", () => {
  const missing = {
    ok: false as const,
    code: PAYMENT_GATEWAY_NOT_CONFIGURED as typeof PAYMENT_GATEWAY_NOT_CONFIGURED,
    role: "driver" as const,
    provider: null,
    reason: "Driver payout gateway not selected for this service area",
  };
  assertEquals(assertGatewayExecutable(missing), missing);
});
