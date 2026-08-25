/**
 * Step 9.4A — Revolut auth read-only lock tests (local mocks only).
 * Never hits live provider. Never writes money.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertBusinessAuditGetIsGetOnly,
  assertMerchantRetrieveIsGetOnly,
  classifyAuthFailure,
  evaluateBusinessTransferAuthMatch,
  evaluateMerchantOrderAuthMatch,
  liveBaseUrls,
  maskProviderId,
  maskSecretFingerprint,
} from "./revolutProviderAuthReadOnlyAuditSSOT.ts";

Deno.test("Merchant retrieveRevolutOrder is GET-only in source", async () => {
  const src = await Deno.readTextFile(new URL("./revolutOrders.ts", import.meta.url));
  const check = assertMerchantRetrieveIsGetOnly(src);
  assertEquals(check.ok, true, check.reasons.join(","));
});

Deno.test("Business audit wrapper is GET /transaction only", async () => {
  const src = await Deno.readTextFile(
    new URL("./revolutProviderAuthReadOnlyAuditSSOT.ts", import.meta.url),
  );
  const check = assertBusinessAuditGetIsGetOnly(src);
  assertEquals(check.ok, true, check.reasons.join(","));
  assertStringIncludes(src, 'method: "GET"');
  assertStringIncludes(src, "/transaction/");
  assertEquals(src.includes("creditCapturedCardTripLedger"), false);
  assertEquals(src.includes("financial_ssot_repairs"), false);
});

Deno.test("live base URLs are production Merchant + Business hosts", () => {
  const urls = liveBaseUrls("live");
  assertEquals(urls.merchant, "https://merchant.revolut.com/api");
  assertEquals(urls.business, "https://b2b.revolut.com/api/1.0");
});

Deno.test("merchant identity + amount match / mismatch fail closed", () => {
  const ok = evaluateMerchantOrderAuthMatch({
    localOrderId: "ord-12345678-abcd",
    localCapturedPence: 480,
    localCurrency: "GBP",
    order: { id: "ord-12345678-abcd", state: "COMPLETED", completed_amount: 480, currency: "GBP" },
  });
  assertEquals(ok.identity_match && ok.amount_currency_match && ok.provider_state_terminal, true);

  const badId = evaluateMerchantOrderAuthMatch({
    localOrderId: "ord-12345678-abcd",
    localCapturedPence: 480,
    localCurrency: "GBP",
    order: { id: "other", state: "COMPLETED", completed_amount: 480, currency: "GBP" },
  });
  assertEquals(badId.identity_match, false);

  const badAmt = evaluateMerchantOrderAuthMatch({
    localOrderId: "ord-12345678-abcd",
    localCapturedPence: 480,
    localCurrency: "GBP",
    order: { id: "ord-12345678-abcd", state: "COMPLETED", completed_amount: 999, currency: "GBP" },
  });
  assertEquals(badAmt.amount_currency_match, false);
});

Deno.test("business transfer match uses major→pence; mismatch reports no write", () => {
  const ok = evaluateBusinessTransferAuthMatch({
    localPaymentId: "pay-aaaaaaaa-bbbb",
    localAmountPence: 1275,
    localCurrency: "GBP",
    localPaymentReference: "driver-payout:5d2fe1d3-3207-4414-ab1e-3d397584a08a",
    transfer: {
      id: "pay-aaaaaaaa-bbbb",
      state: "completed",
      amount: 12.75,
      currency: "GBP",
      reference: "driver-payout:5d2fe1d3-3207-4414-ab1e-3d397584a08a",
    },
  });
  assertEquals(ok.identity_match && ok.amount_currency_match && ok.reference_match, true);

  const bad = evaluateBusinessTransferAuthMatch({
    localPaymentId: "pay-aaaaaaaa-bbbb",
    localAmountPence: 1275,
    localCurrency: "GBP",
    localPaymentReference: "driver-payout:5d2fe1d3",
    transfer: {
      id: "pay-aaaaaaaa-bbbb",
      state: "completed",
      amount: 99.99,
      currency: "GBP",
      reference: "other",
    },
  });
  assertEquals(bad.amount_currency_match, false);
  assertEquals(bad.reference_match, false);
});

Deno.test("auth failure safety: missing/401/403/5xx — no credential retry, no financial action", () => {
  const missing = classifyAuthFailure(new Error("Revolut payment is not configured"));
  assertEquals(missing.kind, "missing_credential");
  assertEquals(missing.retry_with_other_credential, false);
  assertEquals(missing.financial_action, "NONE");

  const u401 = classifyAuthFailure({ message: "Unauthorized", status: 401 });
  assertEquals(u401.kind, "unauthorized");
  assertEquals(u401.retry_with_other_credential, false);

  const u403 = classifyAuthFailure({ message: "Forbidden", status: 403 });
  assertEquals(u403.kind, "forbidden");

  const u503 = classifyAuthFailure({ message: "unavailable", status: 503 });
  assertEquals(u503.kind, "unavailable");
  assertEquals(u503.financial_action, "NONE");
});

Deno.test("secrets and IDs are masked in artifacts helpers", () => {
  assertEquals(maskProviderId("6a846ac8-4182-ab11-b8b4-64eb1c520162"), "6a846ac8…0162");
  const fp = maskSecretFingerprint({
    prefix_class: "sk_",
    len: 67,
    value_sha256: "6955a3149f0c46d6dae1a524ed8c345557821e46ac23583632c45c8ddfbaf5a6",
  });
  assertEquals(fp.sha256_12, "6955a3149f0c");
  assertEquals(fp.prefix_class, "sk_");
});

Deno.test("audit SSOT import graph excludes mutate helpers", async () => {
  const src = await Deno.readTextFile(
    new URL("./revolutProviderAuthReadOnlyAuditSSOT.ts", import.meta.url),
  );
  for (const bad of [
    "captureRevolut",
    "refundRevolut",
    "executeRevolutPay",
    "createRevolutOrder",
    "creditCapturedCardTripLedger",
    "finalize_driver_payout",
    "applyCanonicalSettlement",
  ]) {
    assertEquals(src.includes(bad), false, bad);
  }
});
