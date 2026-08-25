import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CONFIRM_EXECUTE_PHRASE,
  gateExactMk008TripId,
  isApprovedLiveExecute,
  isLiveExecutionRequest,
  MK008_APPROVED_PENCE,
  MK008_TRIP_ID,
} from "./mk008HistoricalMissingTenCreditSSOT.ts";

Deno.test("MK-008 allow-list is exact single UUID; others blocked", () => {
  assertEquals(gateExactMk008TripId([MK008_TRIP_ID]).ok, true);
  assertEquals(gateExactMk008TripId([]).ok, false);
  assertEquals(gateExactMk008TripId([MK008_TRIP_ID, MK008_TRIP_ID]).ok, false);
  assertEquals(gateExactMk008TripId(["ddc88920-1da3-4d2f-a85c-8de61a62d692"]).ok, false);
  assertEquals(MK008_APPROVED_PENCE, 609);
});

Deno.test("live only with exact confirm phrase", () => {
  assertEquals(isApprovedLiveExecute({
    dry_run: false,
    confirm_execute: CONFIRM_EXECUTE_PHRASE,
  }), true);
  assertEquals(isLiveExecutionRequest({ dry_run: false }), true);
  assertEquals(isLiveExecutionRequest({
    dry_run: false,
    confirm_execute: CONFIRM_EXECUTE_PHRASE,
  }), false);
  assertEquals(CONFIRM_EXECUTE_PHRASE, "CREDIT_MK008_ACCEPTED_OFFER_EARNINGS_609P");
});

Deno.test("handler/SSOT: no PS/trip writes; uses canonical ledger; no Revolut", async () => {
  const ssot = await Deno.readTextFile(new URL("./mk008HistoricalMissingTenCreditSSOT.ts", import.meta.url));
  const idx = await Deno.readTextFile(
    new URL("../admin-recover-mk008-historical-missing-ten/index.ts", import.meta.url),
  );
  assertStringIncludes(ssot, "creditCapturedCardTripLedger");
  assertStringIncludes(ssot, "tipPence: 0");
  assertEquals(ssot.includes('from("trips").update'), false);
  assertEquals(ssot.includes('from("payment_sessions").update'), false);
  assertEquals(ssot.includes("refundRevolut"), false);
  assertEquals(idx.includes("financial_ssot_repairs"), false);
});
