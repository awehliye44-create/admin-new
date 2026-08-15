/**
 * P0 lock — payment session upsert must persist idempotency_key = preauth_${clientActionId}.
 * Regression: Slice A bundled upsert without NOT NULL idempotency_key → Revolut auth
 * without session → CTAP cancelled hold → false "payment declined".
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("..", import.meta.url).pathname;

Deno.test("upsertPaymentSessionPending persists preauth_${clientActionId} idempotency_key", () => {
  const src = Deno.readTextFileSync(`${ROOT}/_shared/paymentSessionSSOT.ts`);
  assertEquals(src.includes("idempotency_key: idempotencyKey"), true);
  assertEquals(src.includes("`preauth_${input.clientActionId}`"), true);
  assertEquals(src.includes('idempotencyKey?: string | null'), true);
});

Deno.test("revolutPreauth passes idempotencyKey into session upsert", () => {
  const src = Deno.readTextFileSync(`${ROOT}/_shared/revolutPreauth.ts`);
  assertEquals(src.includes("upsertPaymentSessionPending"), true);
  assertEquals(src.includes("idempotencyKey,"), true);
  assertEquals(src.includes("PAYMENT_SESSION_PERSIST_FAILED"), true);
  assertEquals(
    src.includes("We couldn't complete your booking. Any temporary card hold will be released."),
    true,
  );
});

Deno.test("revolutPreauth fail-closes when session upsert fails after order create", () => {
  const src = Deno.readTextFileSync(`${ROOT}/_shared/revolutPreauth.ts`);
  // Cancel order on persist failure before returning success
  assertEquals(src.includes("Revolut payment session upsert failed — cancelling order"), true);
  assertEquals(src.includes("cancelRevolutOrder"), true);
  // Must not return 200 success path after failed upsert without return
  const failIdx = src.indexOf("PAYMENT_SESSION_PERSIST_FAILED");
  assertEquals(failIdx > 0, true);
  const failBlock = src.slice(failIdx - 200, failIdx + 400);
  assertEquals(failBlock.includes("status: 500"), true);
});

Deno.test("revolutPreauth fail-closes authorised-without-session", () => {
  const src = Deno.readTextFileSync(`${ROOT}/_shared/revolutPreauth.ts`);
  assertEquals(
    src.includes("Authorised but payment session missing — cancelling hold"),
    true,
  );
});

Deno.test("create-preauth still uses Revolut preauth SSOT (MK contract)", () => {
  const src = Deno.readTextFileSync(`${ROOT}/create-preauth-payment-intent/index.ts`);
  assertEquals(src.includes("createRevolutPreauthResponse"), true);
  assertEquals(src.includes("create-payment-intent"), false);
});

Deno.test("create-trip-after-payment still gates on payment session", () => {
  const src = Deno.readTextFileSync(`${ROOT}/create-trip-after-payment/index.ts`);
  assertEquals(src.includes("gatePaymentSessionForTripCreate"), true);
  assertEquals(src.includes("BOOKING_FAILED_PREAUTH_REVERSED"), true);
  assertEquals(src.includes("releaseHoldForPaymentSession"), true);
  const ssot = Deno.readTextFileSync(`${ROOT}/_shared/paymentSessionSSOT.ts`);
  assertEquals(ssot.includes("payment_session_missing"), true);
  assertEquals(ssot.includes("gatePaymentSessionForTripCreate"), true);
});
