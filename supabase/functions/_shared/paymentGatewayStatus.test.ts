import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { gatewayStatusBadge } from "./paymentGatewayStatus.ts";

Deno.test("gatewayStatusBadge maps CONNECTED", () => {
  const badge = gatewayStatusBadge("CONNECTED");
  assertEquals(badge.label, "Connected");
  assertEquals(badge.emoji, "🟢");
});

Deno.test("gatewayStatusBadge maps NOT_CONFIGURED", () => {
  const badge = gatewayStatusBadge("NOT_CONFIGURED");
  assertEquals(badge.label, "Not Configured");
  assertEquals(badge.emoji, "⚪");
});

Deno.test("gatewayStatusBadge maps TEST_MODE", () => {
  const badge = gatewayStatusBadge("TEST_MODE");
  assertEquals(badge.label, "Test Mode");
  assertEquals(badge.emoji, "🔵");
});
