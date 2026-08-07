import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  assertGatewayExecutable,
  PAYMENT_GATEWAY_NOT_CONFIGURED,
  type GatewayConfiguredResult,
} from "./paymentGatewayGuard.ts";

const revolutOk: GatewayConfiguredResult = {
  ok: true,
  provider: "revolut",
  environment: "live",
  display_name: "Revolut",
  role: "customer",
};

Deno.test("assertGatewayExecutable allows Revolut", () => {
  assertEquals(assertGatewayExecutable(revolutOk), revolutOk);
});

Deno.test("assertGatewayExecutable blocks retired Stripe", () => {
  const stripe: GatewayConfiguredResult = {
    ok: true,
    provider: "stripe",
    environment: "live",
    display_name: "Stripe",
    role: "customer",
  };
  const result = assertGatewayExecutable(stripe);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.provider, "stripe");
    assertEquals(result.role, "customer");
  }
});

Deno.test("assertGatewayExecutable blocks providers without live adapters", () => {
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
