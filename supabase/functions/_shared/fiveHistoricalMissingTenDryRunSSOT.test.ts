import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ALLOWLIST_VIOLATION,
  APPROVED_TOTAL_PENCE,
  CONFIRM_EXECUTE_PHRASE,
  EXCLUDED_PENDING_MK008_TRIP_ID,
  FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST,
  FIVE_HISTORICAL_MISSING_TEN_IDS,
  gateExactFiveTripAllowlist,
  isApprovedLiveExecute,
  isLiveExecutionRequest,
  LIVE_EXECUTION_DISABLED,
} from "./fiveHistoricalMissingTenDryRunSSOT.ts";

Deno.test("exact five allow-list IDs and total 2629p", () => {
  assertEquals(FIVE_HISTORICAL_MISSING_TEN_IDS.length, 5);
  assertEquals(APPROVED_TOTAL_PENCE, 2629);
  const sum = Object.values(FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST).reduce(
    (s, r) => s + r.approved_amount_pence,
    0,
  );
  assertEquals(sum, 2629);
  assertEquals(FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST["ddc88920-1da3-4d2f-a85c-8de61a62d692"].approved_amount_pence, 425);
  assertEquals(FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST["49883300-872b-42e5-917b-542f9deaf772"].approved_amount_pence, 382);
  assertEquals(FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST["e594e764-c108-4b67-8a6e-80934019df2f"].approved_amount_pence, 670);
  assertEquals(FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST["32315218-b0b3-44d2-bf4c-cfa7c5619acc"].approved_amount_pence, 744);
  assertEquals(FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST["229223e3-c100-495d-afd8-2c39a3acf6b2"].approved_amount_pence, 408);
});

Deno.test("gate accepts exact five; MK-008/unknown/dup/partial blocked", () => {
  assertEquals(gateExactFiveTripAllowlist([...FIVE_HISTORICAL_MISSING_TEN_IDS].reverse()).ok, true);
  const with008 = [...FIVE_HISTORICAL_MISSING_TEN_IDS];
  with008[0] = EXCLUDED_PENDING_MK008_TRIP_ID;
  const g008 = gateExactFiveTripAllowlist(with008);
  assertEquals(g008.ok, false);
  if (!g008.ok) assertEquals(g008.error, ALLOWLIST_VIOLATION);
  assertEquals(gateExactFiveTripAllowlist(FIVE_HISTORICAL_MISSING_TEN_IDS.slice(0, 4)).ok, false);
  assertEquals(gateExactFiveTripAllowlist([
    ...FIVE_HISTORICAL_MISSING_TEN_IDS.slice(0, 4),
    FIVE_HISTORICAL_MISSING_TEN_IDS[0],
  ]).ok, false);
  assertEquals(gateExactFiveTripAllowlist([
    ...FIVE_HISTORICAL_MISSING_TEN_IDS.slice(0, 4),
    "00000000-0000-0000-0000-000000000001",
  ]).ok, false);
});

Deno.test("live execute only with exact confirm phrase", () => {
  assertEquals(isApprovedLiveExecute({
    dry_run: false,
    confirm_execute: CONFIRM_EXECUTE_PHRASE,
  }), true);
  assertEquals(isApprovedLiveExecute({ dry_run: false, confirm_execute: "WRONG" }), false);
  assertEquals(isApprovedLiveExecute({ dry_run: true, confirm_execute: CONFIRM_EXECUTE_PHRASE }), false);
  assertEquals(isLiveExecutionRequest({ dry_run: false }), true);
  assertEquals(isLiveExecutionRequest({ dry_run: false, confirm_execute: "WRONG" }), true);
  assertEquals(isLiveExecutionRequest({
    dry_run: false,
    confirm_execute: CONFIRM_EXECUTE_PHRASE,
  }), false);
  assertEquals(isLiveExecutionRequest({ dry_run: true }), false);
  assertEquals(CONFIRM_EXECUTE_PHRASE, "CREDIT_FIVE_SAVED_TRIP_EARNINGS_2629P");
});

Deno.test("handler: confirm phrase + canonical ledger credit; no provider/MK007", async () => {
  const src = await Deno.readTextFile(
    new URL("../admin-recover-five-historical-missing-ten/index.ts", import.meta.url),
  );
  assertStringIncludes(src, LIVE_EXECUTION_DISABLED);
  assertStringIncludes(src, CONFIRM_EXECUTE_PHRASE);
  assertStringIncludes(src, "executeFiveTripCredit");
  assertStringIncludes(src, "requireSuperAdminOrServiceRole");
  assertEquals(src.includes("refundRevolut"), false);
  assertEquals(src.includes("MK-260817-007"), false);
  assertEquals(src.includes("MK-007"), false);
  assertEquals(src.includes("financial_ssot_repairs"), false);
  assertEquals(src.includes("capturedTripWalletRecovery"), false);
});

Deno.test("SSOT: uses creditCapturedCardTripLedger; no PS/trip/provider writes; economic from captured_at", async () => {
  const src = await Deno.readTextFile(new URL("./fiveHistoricalMissingTenDryRunSSOT.ts", import.meta.url));
  assertStringIncludes(src, "creditCapturedCardTripLedger");
  assertStringIncludes(src, "tipPence: 0");
  assertStringIncludes(src, "ALREADY_CREDITED");
  assertStringIncludes(src, "CANONICAL_CAPTURED_AT");
  assertEquals(src.includes('from("payment_sessions").update'), false);
  assertEquals(src.includes('from("trips").update'), false);
  assertEquals(src.includes("refundRevolut"), false);
  assertEquals(src.includes("fetch("), false);
  assertEquals(/0\.85|Math\.round\([^)]*\*\s*0\./.test(src), false);
  assertEquals(src.includes("MK-260817-007"), false);
});

Deno.test("fail-closed paths remain in SSOT", async () => {
  const src = await Deno.readTextFile(new URL("./fiveHistoricalMissingTenDryRunSSOT.ts", import.meta.url));
  assertStringIncludes(src, "existing TEN");
  assertStringIncludes(src, "Commission Wallet");
  assertStringIncludes(src, "PLATFORM_COLLECTED");
  assertStringIncludes(src, "multiple RIDE_BOOKING");
  assertStringIncludes(src, "sessionLooksCaptured");
});
