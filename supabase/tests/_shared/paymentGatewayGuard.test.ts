import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  assertGatewayExecutable,
  PAYMENT_GATEWAY_NOT_CONFIGURED,
  PROVIDER_NOT_IMPLEMENTED,
  type GatewayConfiguredResult,
} from "../../functions/_shared/paymentGatewayGuard.ts";

// Production executable adapter is Revolut-only (assertGatewayExecutable).
// Baseline on origin/main: identical guard + previously outdated fixtures that
// expected a stub provider "provider" to pass and paystack to return
// PAYMENT_GATEWAY_NOT_CONFIGURED. Guard was never weakened — fixtures updated
// to match the revolut-only executable contract.
const revolutOk: GatewayConfiguredResult = {
  ok: true,
  provider: "revolut",
  environment: "live",
  display_name: "Revolut",
  role: "customer",
};

Deno.test("assertGatewayExecutable allows revolut", () => {
  assertEquals(assertGatewayExecutable(revolutOk), revolutOk);
});

Deno.test("assertGatewayExecutable blocks non-revolut providers as not implemented", () => {
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
    assertEquals(result.code, PROVIDER_NOT_IMPLEMENTED);
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
