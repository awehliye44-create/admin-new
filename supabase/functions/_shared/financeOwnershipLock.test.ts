/**
 * Finance ownership lock — current change must not give Financial Reconciliation
 * money or repair power, and Payout Ledger must consume Driver Wallet Ledger only.
 *
 * Run: deno test --allow-read --no-check supabase/functions/_shared/financeOwnershipLock.test.ts
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PAYOUT_ELIGIBLE_LEDGER_TYPES } from "./driverPayoutEligibilitySSOT.ts";
import { FR_TRIP_AUDIT_STATUS } from "./frConsumeOnlySSOT.ts";

Deno.test("FR monitor does not insert or retry Driver Wallet Ledger money", async () => {
  const src = await Deno.readTextFile(new URL("../financial-ssot-monitor/index.ts", import.meta.url));
  assertEquals(src.includes("creditCapturedCardTripLedger"), false);
  assertEquals(src.includes("applyCanonicalSettlementAfterCapture"), false);
  assertEquals(src.includes('from("driver_wallet_ledger").insert'), false);
  assertStringIncludes(src, "financial_ssot_mismatches");
});

Deno.test("canonical posting service owns TRIP_EARNING_NET insert", async () => {
  const src = await Deno.readTextFile(
    new URL("./applyCanonicalSettlementAfterCapture.ts", import.meta.url),
  );
  assertStringIncludes(src, "creditCapturedCardTripLedger");
  assertStringIncludes(src, "not Financial Reconciliation");
  assertEquals(src.includes('from("payments")'), false);
});

Deno.test("Payout Ledger eligible types are Driver Wallet Ledger earning credits only", () => {
  assertEquals([...PAYOUT_ELIGIBLE_LEDGER_TYPES].sort(), [
    "DRIVER_TIP_CREDIT",
    "TIP_CREDIT",
    "TRIP_EARNING_NET",
  ]);
});

Deno.test("FR trip audit status includes WALLET_MISMATCH and does not own posting", () => {
  assertEquals(FR_TRIP_AUDIT_STATUS.WALLET_MISMATCH, "WALLET_MISMATCH");
});

Deno.test("FR contains no captured-trip wallet recovery / money write path", async () => {
  const files = [
    "../financial-ssot-monitor/index.ts",
    "./frPerTripAuditSSOT.ts",
    "./frConsumeOnlySSOT.ts",
    "./frTripAuditComparisonSSOT.ts",
    "../admin-finance-reconciliation/index.ts",
  ];
  for (const rel of files) {
    const src = await Deno.readTextFile(new URL(rel, import.meta.url));
    assertEquals(src.includes("recoverCapturedTripWallet"), false, rel);
    assertEquals(src.includes("capturedTripWalletRecovery"), false, rel);
    assertEquals(src.includes("creditCapturedCardTripLedger"), false, rel);
    assertEquals(src.includes('from("driver_wallet_ledger").insert'), false, rel);
  }
});

Deno.test("activation gates recovery only — never fresh_capture", async () => {
  const src = await Deno.readTextFile(
    new URL("./applyCanonicalSettlementAfterCapture.ts", import.meta.url),
  );
  assertEquals((src.match(/mayRetryWalletPosting/g) ?? []).length, 2);
  const recoveryGate = src.slice(
    src.indexOf('if (mode === "recovery") {'),
    src.indexOf("let gateLoad = await loadPaymentSessionCaptureGate"),
  );
  assertEquals(recoveryGate.includes("mayRetryWalletPosting"), true);
  const afterGate = src.slice(src.indexOf("let gateLoad = await loadPaymentSessionCaptureGate"));
  assertEquals(afterGate.includes("mayRetryWalletPosting"), false);
});

Deno.test("fresh capture persists Payment Sessions before wallet posting", async () => {
  const src = await Deno.readTextFile(
    new URL("./revolutCompletionCapture.ts", import.meta.url),
  );
  const firstMark = src.indexOf("await markPaymentSessionCaptured");
  const firstWallet = src.indexOf("await applyCanonicalSettlementAfterCapture");
  assertEquals(firstMark >= 0 && firstWallet > firstMark, true);
  assertEquals(src.includes("recordPaymentSessionPersistFailureMetadata"), true);
});

Deno.test("admin capture delegates wallet posting to applyCanonicalSettlementAfterCapture", async () => {
  const src = await Deno.readTextFile(
    new URL("./adminCaptureTripPaymentSSOT.ts", import.meta.url),
  );
  assertEquals(src.includes("applyCanonicalSettlementAfterCapture"), true);
  assertEquals(src.includes("creditCapturedCardTripLedger"), false);
  assertEquals(src.includes('from("driver_wallet_ledger").insert'), false);
});

Deno.test("recovery saved-stamp helper source never calls tripSettlement calculator", async () => {
  const src = await Deno.readTextFile(
    new URL("./applyCanonicalSettlementAfterCapture.ts", import.meta.url),
  );
  const start = src.indexOf("export function recoveryWalletCreditFromSavedStamps");
  const end = src.indexOf("function supabaseErrorParts");
  const fn = src.slice(start, end);
  assertEquals(fn.includes("calculateTripSettlement"), false);
  assertEquals(fn.includes("resolveCapturedTripEarningNetPence"), false);
  assertEquals(fn.includes("tripSettlementDbColumns"), false);
  assertEquals(src.includes("recoveryWalletCreditFromSavedStamps(args.trip)"), true);
});
