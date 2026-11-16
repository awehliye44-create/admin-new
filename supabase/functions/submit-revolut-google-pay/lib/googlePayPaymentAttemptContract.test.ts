import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildGooglePayAttemptSnapshot,
  orderTokenSuffix,
  readGooglePayAttemptSnapshot,
  sha256Hex,
  verifyGooglePayAttemptBinding,
} from "./googlePayPaymentAttemptContract.ts";

const ORDER_ID = "6af9d0c6-6794-a617-960f-2e29698fb0bc";
const ORDER_TOKEN = "621e5cc2-9897-41af-8287-8a28825ec786";
const SESSION_ID = "5afefb62-d600-4fd3-9263-5c92faffb269";

Deno.test("buildGooglePayAttemptSnapshot binds order token ≠ order id (success-era shape)", async () => {
  const snap = await buildGooglePayAttemptSnapshot({
    paymentSessionId: SESSION_ID,
    providerOrderId: ORDER_ID,
    orderToken: ORDER_TOKEN,
    amountPence: 500,
    currency: "GBP",
  });
  assertEquals(snap.provider_order_id, ORDER_ID);
  assertEquals(snap.order_token_suffix, "825ec786");
  assertEquals(snap.order_token_sha256, await sha256Hex(ORDER_TOKEN));
  assertEquals(snap.amount_pence, 500);
  assertEquals(snap.currency, "GBP");
  assertEquals(orderTokenSuffix(ORDER_TOKEN), "825ec786");
});

Deno.test("buildGooglePayAttemptSnapshot rejects order id used as gateway token", async () => {
  let threw = false;
  try {
    await buildGooglePayAttemptSnapshot({
      paymentSessionId: SESSION_ID,
      providerOrderId: ORDER_ID,
      orderToken: ORDER_ID,
      amountPence: 500,
      currency: "GBP",
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("verifyGooglePayAttemptBinding accepts matching gateway merchant sha", async () => {
  const snap = await buildGooglePayAttemptSnapshot({
    paymentSessionId: SESSION_ID,
    providerOrderId: ORDER_ID,
    orderToken: ORDER_TOKEN,
    amountPence: 500,
    currency: "gbp",
  });
  const ok = verifyGooglePayAttemptBinding({
    snapshot: snap,
    paymentSessionId: SESSION_ID,
    providerOrderId: ORDER_ID,
    gatewayMerchantIdSha256: await sha256Hex(ORDER_TOKEN),
    amountPence: 500,
    currency: "GBP",
  });
  assertEquals(ok.ok, true);
});

Deno.test("verifyGooglePayAttemptBinding rejects mismatched order id (replacement order)", async () => {
  const snap = await buildGooglePayAttemptSnapshot({
    paymentSessionId: SESSION_ID,
    providerOrderId: ORDER_ID,
    orderToken: ORDER_TOKEN,
    amountPence: 500,
    currency: "GBP",
  });
  const bad = verifyGooglePayAttemptBinding({
    snapshot: snap,
    paymentSessionId: SESSION_ID,
    providerOrderId: "6afb58fd-c9ac-ac08-b38b-4dda3266ec20",
    gatewayMerchantIdSha256: await sha256Hex(ORDER_TOKEN),
  });
  assertEquals(bad.ok, false);
  if (!bad.ok) assertEquals(bad.code, "GOOGLE_PAY_ATTEMPT_ORDER_MISMATCH");
});

Deno.test("verifyGooglePayAttemptBinding rejects stale cached token vs new order token", async () => {
  const snap = await buildGooglePayAttemptSnapshot({
    paymentSessionId: SESSION_ID,
    providerOrderId: ORDER_ID,
    orderToken: ORDER_TOKEN,
    amountPence: 500,
    currency: "GBP",
  });
  const staleToken = "11111111-2222-3333-4444-555555555555";
  const bad = verifyGooglePayAttemptBinding({
    snapshot: snap,
    paymentSessionId: SESSION_ID,
    providerOrderId: ORDER_ID,
    gatewayMerchantIdSha256: await sha256Hex(staleToken),
  });
  assertEquals(bad.ok, false);
  if (!bad.ok) assertEquals(bad.code, "GOOGLE_PAY_ATTEMPT_TOKEN_MISMATCH");
});

Deno.test("verifyGooglePayAttemptBinding rejects amount drift after Wallet open", async () => {
  const snap = await buildGooglePayAttemptSnapshot({
    paymentSessionId: SESSION_ID,
    providerOrderId: ORDER_ID,
    orderToken: ORDER_TOKEN,
    amountPence: 500,
    currency: "GBP",
  });
  const bad = verifyGooglePayAttemptBinding({
    snapshot: snap,
    paymentSessionId: SESSION_ID,
    providerOrderId: ORDER_ID,
    gatewayMerchantIdSha256: await sha256Hex(ORDER_TOKEN),
    amountPence: 763,
  });
  assertEquals(bad.ok, false);
  if (!bad.ok) assertEquals(bad.code, "GOOGLE_PAY_ATTEMPT_AMOUNT_MISMATCH");
});

Deno.test("verifyGooglePayAttemptBinding rejects missing gateway sha (fail closed)", () => {
  const bad = verifyGooglePayAttemptBinding({
    snapshot: {
      generation: 1,
      payment_session_id: SESSION_ID,
      provider_order_id: ORDER_ID,
      order_token_sha256: "a".repeat(64),
      order_token_suffix: "825ec786",
      amount_pence: 500,
      currency: "GBP",
      created_at: new Date().toISOString(),
    },
    paymentSessionId: SESSION_ID,
    providerOrderId: ORDER_ID,
    gatewayMerchantIdSha256: null,
  });
  assertEquals(bad.ok, false);
  if (!bad.ok) assertEquals(bad.code, "GOOGLE_PAY_ATTEMPT_GATEWAY_SHA_MISSING");
});

Deno.test("readGooglePayAttemptSnapshot round-trips metadata", async () => {
  const snap = await buildGooglePayAttemptSnapshot({
    paymentSessionId: SESSION_ID,
    providerOrderId: ORDER_ID,
    orderToken: ORDER_TOKEN,
    amountPence: 500,
    currency: "GBP",
    generation: 2,
  });
  const read = readGooglePayAttemptSnapshot({ google_pay_attempt: snap });
  assertEquals(read, snap);
});

Deno.test("duplicate callback with matching sha is accepted (idempotent-ready)", async () => {
  const snap = await buildGooglePayAttemptSnapshot({
    paymentSessionId: SESSION_ID,
    providerOrderId: ORDER_ID,
    orderToken: ORDER_TOKEN,
    amountPence: 500,
    currency: "GBP",
  });
  const sha = await sha256Hex(ORDER_TOKEN);
  const first = verifyGooglePayAttemptBinding({
    snapshot: snap,
    paymentSessionId: SESSION_ID,
    providerOrderId: ORDER_ID,
    gatewayMerchantIdSha256: sha,
  });
  const second = verifyGooglePayAttemptBinding({
    snapshot: snap,
    paymentSessionId: SESSION_ID,
    providerOrderId: ORDER_ID,
    gatewayMerchantIdSha256: sha,
  });
  assertEquals(first.ok, true);
  assertEquals(second.ok, true);
});

Deno.test("concurrent attempt against replacement order is rejected", async () => {
  const snapA = await buildGooglePayAttemptSnapshot({
    paymentSessionId: SESSION_ID,
    providerOrderId: ORDER_ID,
    orderToken: ORDER_TOKEN,
    amountPence: 500,
    currency: "GBP",
    generation: 1,
  });
  const replacementOrder = "6afb58fd-c9ac-ac08-b38b-4dda3266ec20";
  const replacementToken = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const bad = verifyGooglePayAttemptBinding({
    snapshot: snapA,
    paymentSessionId: SESSION_ID,
    providerOrderId: replacementOrder,
    gatewayMerchantIdSha256: await sha256Hex(replacementToken),
  });
  assertEquals(bad.ok, false);
  if (!bad.ok) assertEquals(bad.code, "GOOGLE_PAY_ATTEMPT_ORDER_MISMATCH");
});

Deno.test("expired / missing attempt fails closed", () => {
  const bad = verifyGooglePayAttemptBinding({
    snapshot: null,
    paymentSessionId: SESSION_ID,
    providerOrderId: ORDER_ID,
    gatewayMerchantIdSha256: "a".repeat(64),
  });
  assertEquals(bad.ok, false);
  if (!bad.ok) assertEquals(bad.code, "GOOGLE_PAY_ATTEMPT_MISSING");
});

Deno.test("success-era gatewayMerchantId is order.token not order.id", async () => {
  // Last successful session 5afefb62 used order token as gatewayMerchantId (official Revolut Android S2S).
  const snap = await buildGooglePayAttemptSnapshot({
    paymentSessionId: "5afefb62-d600-4fd3-9263-5c92faffb269",
    providerOrderId: ORDER_ID,
    orderToken: ORDER_TOKEN,
    amountPence: 500,
    currency: "GBP",
  });
  assertEquals(snap.order_token_sha256 !== (await sha256Hex(ORDER_ID)), true);
  assertEquals(snap.provider_order_id, ORDER_ID);
});
