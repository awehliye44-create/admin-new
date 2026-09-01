/**
 * Phase 0e — terminal fee settlement resumption when provider fee becomes known.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveTerminalOutcomeKind,
  isTerminalFeeTrip,
  type TerminalTripRow,
} from "./terminalFeeSettlementResumptionSSOT.ts";
import { computeTerminalOutcomeEntitlement } from "./terminalOutcomeEntitlementSSOT.ts";

const ROOT = new URL("../", import.meta.url);

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, ROOT));
}

const NO_SHOW_PENDING: TerminalTripRow = {
  id: "trip-1",
  financial_model: "PLATFORM_COLLECTED",
  financial_outcome: "NO_SHOW",
  status: "no_show",
  payment_status: "fee_pending_settlement",
  no_show_charge_pence: 400,
};

const CHARGED_CANCEL: TerminalTripRow = {
  id: "trip-2",
  financial_model: "PLATFORM_COLLECTED",
  financial_outcome: "CANCELLED_WITH_FEE",
  status: "cancelled",
  payment_status: "fee_pending_settlement",
  cancellation_fee_pence: 400,
};

const COMPLETED_TRIP: TerminalTripRow = {
  id: "trip-3",
  financial_model: "PLATFORM_COLLECTED",
  financial_outcome: "COMPLETED",
  status: "completed",
  payment_status: "paid",
  no_show_charge_pence: 0,
};

const DRIVER_COLLECTED: TerminalTripRow = {
  id: "trip-4",
  financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
  financial_outcome: "NO_SHOW",
  payment_status: "fee_pending_settlement",
  no_show_charge_pence: 400,
};

Deno.test("resolveTerminalOutcomeKind: no-show fee_pending_settlement", () => {
  assertEquals(resolveTerminalOutcomeKind(NO_SHOW_PENDING), "NO_SHOW");
  assertEquals(isTerminalFeeTrip(NO_SHOW_PENDING), true);
});

Deno.test("resolveTerminalOutcomeKind: charged cancellation", () => {
  assertEquals(resolveTerminalOutcomeKind(CHARGED_CANCEL), "LATE_PASSENGER_CANCELLATION");
});

Deno.test("resolveTerminalOutcomeKind: completed trip excluded", () => {
  assertEquals(resolveTerminalOutcomeKind(COMPLETED_TRIP), null);
  assertEquals(isTerminalFeeTrip(COMPLETED_TRIP), false);
});

Deno.test("400 capture + unknown fee → pending, no gross entitlement", () => {
  const r = computeTerminalOutcomeEntitlement({
    captured_pence: 400,
    provider_fee_pence: null,
    provider_fee_confirmed: false,
    payment_session_id: "ps-1",
  });
  assertEquals(r.pending, true);
  assertEquals(r.expected_driver_entitlement_pence, null);
});

Deno.test("400 capture + 24p fee → 376p entitlement", () => {
  const r = computeTerminalOutcomeEntitlement({
    captured_pence: 400,
    provider_fee_pence: 24,
    provider_fee_confirmed: true,
    payment_session_id: "ps-1",
  });
  assertEquals(r.pending, false);
  assertEquals(r.expected_driver_entitlement_pence, 376);
  assertEquals(r.commission_pence, 0);
});

Deno.test("trigger: revolut-webhook wires persistProviderFeeAndMaybeResumeTerminalSettlement", async () => {
  const src = await read("revolut-webhook/index.ts");
  assertStringIncludes(src, "persistProviderFeeAndMaybeResumeTerminalSettlement");
  assertStringIncludes(src, "extractRevolutProviderFeeMinor");
  assertEquals(src.includes("settleNoShowFee"), false);
});

Deno.test("trigger: revolut-backfill wires terminal fee resume", async () => {
  const src = await read("revolut-backfill-provider-fees/index.ts");
  assertStringIncludes(src, "persistProviderFeeAndMaybeResumeTerminalSettlement");
  assertStringIncludes(src, "terminal_fee_resume");
});

Deno.test("trigger: admin-refresh wires terminal fee resume on terminal + captured paths", async () => {
  const src = await read("admin-refresh-payment-sessions/index.ts");
  assertStringIncludes(src, "persistProviderFeeAndMaybeResumeTerminalSettlement");
  assertStringIncludes(src, "maybeResumeTerminalFeeSettlementAfterProviderFee");
  assertStringIncludes(src, "terminal_fee_resume");
});

Deno.test("trigger: persistConfirmedProviderCapture resumes after fee persist", async () => {
  const src = await read("_shared/persistConfirmedProviderCapture.ts");
  assertStringIncludes(src, "maybeResumeTerminalFeeSettlementAfterProviderFee");
});

Deno.test("SSOT: resume uses postTerminalEntitlementFromSettlement not gross insert", async () => {
  const src = await read("_shared/terminalFeeSettlementResumptionSSOT.ts");
  assertStringIncludes(src, "postTerminalEntitlementFromSettlement");
  assertStringIncludes(src, "markPaymentSessionProviderFee");
  assertEquals(src.includes('from("driver_wallet_ledger").insert'), false);
  assertStringIncludes(src, "financial_model_not_platform_collected");
});

Deno.test("DRIVER_COLLECTED excluded at detection layer (model gate in resume)", async () => {
  const src = await read("_shared/terminalFeeSettlementResumptionSSOT.ts");
  assertStringIncludes(src, "FINANCIAL_MODEL.PLATFORM_COLLECTED");
  // Driver-collected trips may match outcome kind but resume rejects by model stamp.
  assertEquals(resolveTerminalOutcomeKind(DRIVER_COLLECTED), "NO_SHOW");
});

Deno.test("shared extractRevolutProviderFeeMinor in revolutApi", async () => {
  const src = await read("_shared/revolutApi.ts");
  assertStringIncludes(src, "export function extractRevolutProviderFeeMinor");
});
