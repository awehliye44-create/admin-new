/**
 * Lock: confirm-revolut-payment must honour client max_wait_ms and never
 * hardcode a 22s booking wait (nested client polls → multi-minute Book).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CONFIRM_REVOLUT_BOOKING_CAP_MS,
  CONFIRM_REVOLUT_SAVE_CARD_CAP_MS,
  resolveConfirmRevolutMaxWaitMs,
} from "./confirmRevolutPaymentWaitSSOT.ts";

const ROOT = new URL("..", import.meta.url).pathname;

Deno.test("resolveConfirmRevolutMaxWaitMs: client 0 → single retrieve", () => {
  const r = resolveConfirmRevolutMaxWaitMs({ max_wait_ms: 0 });
  assertEquals(r.maxWaitMs, 0);
  assertEquals(r.pollIntervalMs, 0);
  assertEquals(r.clientSpecified, true);
});

Deno.test("resolveConfirmRevolutMaxWaitMs: booking capped at 2s", () => {
  const r = resolveConfirmRevolutMaxWaitMs({ max_wait_ms: 90_000 });
  assertEquals(r.maxWaitMs, CONFIRM_REVOLUT_BOOKING_CAP_MS);
  assertEquals(CONFIRM_REVOLUT_BOOKING_CAP_MS, 2_000);
});

Deno.test("resolveConfirmRevolutMaxWaitMs: save-card capped at 10s", () => {
  const r = resolveConfirmRevolutMaxWaitMs({
    max_wait_ms: 90_000,
    expect_saved_card_token: true,
  });
  assertEquals(r.maxWaitMs, CONFIRM_REVOLUT_SAVE_CARD_CAP_MS);
  assertEquals(CONFIRM_REVOLUT_SAVE_CARD_CAP_MS, 10_000);
});

Deno.test("resolveConfirmRevolutMaxWaitMs: legacy omit → booking 2s cap", () => {
  const r = resolveConfirmRevolutMaxWaitMs({});
  assertEquals(r.maxWaitMs, CONFIRM_REVOLUT_BOOKING_CAP_MS);
  assertEquals(r.clientSpecified, false);
});

Deno.test("confirm-revolut-payment uses wait SSOT (no hardcoded 22s)", () => {
  const src = Deno.readTextFileSync(
    `${ROOT}/confirm-revolut-payment/index.ts`,
  );
  assertEquals(src.includes("resolveConfirmRevolutMaxWaitMs"), true);
  assertEquals(src.includes("confirmRevolutPaymentWaitSSOT"), true);
  assertEquals(src.includes("22_000"), false);
  assertEquals(src.includes("maxWaitMs: isSaveCardConfirm ? 10_000 : 22_000"), false);
});

Deno.test("verifyRevolutOrderConfirmedForBooking skips trailing retrieve when maxWaitMs=0", () => {
  const src = Deno.readTextFileSync(
    `${ROOT}/_shared/revolutPaymentConfirmation.ts`,
  );
  assertEquals(src.includes("maxWaitMs <= 0 && lastOrder != null"), true);
  assertEquals(src.includes("double-hit Merchant API"), true);
});

Deno.test("saved-card create-preauth settle poll stays under ~1s sleep", () => {
  const src = Deno.readTextFileSync(`${ROOT}/_shared/revolutPreauth.ts`);
  assertEquals(src.includes("[0, 100, 250, 500]"), true);
  assertEquals(src.includes("[0, 150, 300, 600, 1000, 2000, 3000]"), false);
});

Deno.test("token capture poll never uses the old ~82s ladder", () => {
  const src = Deno.readTextFileSync(
    `${ROOT}/_shared/customerSavedPaymentMethodTokens.ts`,
  );
  assertEquals(
    src.includes("[0, 400, 900, 1800, 3200, 6000, 10000, 15000, 20000, 25000]"),
    false,
  );
  assertEquals(src.includes('pollProfile === "setup"'), true);
  assertEquals(src.includes("[0, 100, 250, 500]"), true);
});

Deno.test("booking confirm defers token capture off Finding critical path", () => {
  const src = Deno.readTextFileSync(
    `${ROOT}/confirm-revolut-payment/index.ts`,
  );
  assertEquals(src.includes("token_capture_deferred"), true);
  assertEquals(src.includes("EdgeRuntime.waitUntil"), true);
  assertEquals(src.includes('pollProfile: "booking"'), true);
});
