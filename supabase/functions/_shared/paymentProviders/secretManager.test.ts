import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { detectModeMismatch, maskSecretValue } from "./secretManager.ts";

Deno.test("maskSecretValue masks middle of secret keys", () => {
  assertEquals(maskSecretValue("sk_live_abc1234567890"), "sk_live_••••7890");
  assertEquals(maskSecretValue("pk_live_abcdefghij"), "pk_live_••••ghij");
  assertEquals(maskSecretValue("whsec_abcdefghijklmnop"), "whsec_••••mnop");
});

Deno.test("detectModeMismatch flags live key in test mode", () => {
  const msg = detectModeMismatch("test", "sk_live_abc123");
  assertEquals(msg?.startsWith("Critical"), true);
});

Deno.test("detectModeMismatch flags test key in live mode", () => {
  const msg = detectModeMismatch("live", "sk_test_abc123");
  assertEquals(msg?.startsWith("Critical"), true);
});
