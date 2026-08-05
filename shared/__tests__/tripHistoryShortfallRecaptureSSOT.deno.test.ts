/**
 * Deno-compatible unit tests for tripHistoryShortfallRecaptureSSOT.
 * Run: deno test --allow-read --no-check shared/__tests__/tripHistoryShortfallRecaptureSSOT.deno.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeOutstandingShortfallPence,
  evaluateTripHistoryShortfallRecaptureEligibility,
  isFullyPaidCapturedCoverage,
  paymentCoverageBadgeLabel,
  recaptureActionLabel,
  TRIP_SHORTFALL_RECAPTURE_UI_STATE,
} from "../tripHistoryShortfallRecaptureSSOT.ts";

Deno.test("full payment → no recapture", () => {
  const gate = evaluateTripHistoryShortfallRecaptureEligibility({
    tripStatus: "completed",
    customerPayablePence: 793,
    verifiedCapturedTotalPence: 793,
    providerSettlementVerified: true,
    adminPermitted: true,
  });
  assertEquals(gate.eligible, false);
  assertEquals(gate.ui_state, TRIP_SHORTFALL_RECAPTURE_UI_STATE.FULLY_PAID);
  assertEquals(gate.outstanding_shortfall_pence, 0);
});

Deno.test("£7.93 shortfall → exact recapture available", () => {
  const gate = evaluateTripHistoryShortfallRecaptureEligibility({
    tripStatus: "completed",
    paymentMethod: "card",
    customerPayablePence: 793,
    verifiedCapturedTotalPence: 0,
    adminPermitted: true,
  });
  assertEquals(gate.eligible, true);
  assertEquals(gate.outstanding_shortfall_pence, 793);
  assertEquals(recaptureActionLabel(793), "Recapture £7.93");
});

Deno.test("canceled is never Fully paid / Captured", () => {
  assertEquals(
    isFullyPaidCapturedCoverage({
      customerPayablePence: 793,
      verifiedCapturedTotalPence: 0,
      providerSettlementVerified: false,
      paymentStatus: "canceled",
      providerStatus: "canceled",
    }),
    false,
  );
  const badge = paymentCoverageBadgeLabel({
    customerPayablePence: 793,
    verifiedCapturedTotalPence: 0,
    providerSettlementVerified: false,
    paymentStatus: "canceled",
    providerStatus: "canceled",
  });
  assertEquals(badge.tone, "canceled");
  assertEquals(/Fully paid/i.test(badge.label), false);
});

Deno.test("DRIVER_COLLECTED blocked", () => {
  const gate = evaluateTripHistoryShortfallRecaptureEligibility({
    tripStatus: "completed",
    financialModel: "DRIVER_COLLECTED_COMMISSION_WALLET",
    customerPayablePence: 793,
    verifiedCapturedTotalPence: 0,
    adminPermitted: true,
  });
  assertEquals(gate.eligible, false);
  assertEquals(gate.reject_reason, "driver_collected_not_allowed");
});

Deno.test("unauthorized admin blocked", () => {
  const gate = evaluateTripHistoryShortfallRecaptureEligibility({
    tripStatus: "completed",
    customerPayablePence: 793,
    verifiedCapturedTotalPence: 0,
    adminPermitted: false,
  });
  assertEquals(gate.eligible, false);
  assertEquals(gate.reject_reason, "admin_not_permitted");
});

Deno.test("open recovery blocks duplicate", () => {
  const gate = evaluateTripHistoryShortfallRecaptureEligibility({
    tripStatus: "completed",
    customerPayablePence: 793,
    verifiedCapturedTotalPence: 0,
    hasOpenRecoveryAttempt: true,
    adminPermitted: true,
  });
  assertEquals(gate.eligible, false);
  assertEquals(gate.ui_state, TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING);
});

Deno.test("refund reopens shortfall", () => {
  assertEquals(
    computeOutstandingShortfallPence({
      customerPayablePence: 793,
      verifiedCapturedTotalPence: 793,
      netRefundedTotalPence: 200,
    }),
    200,
  );
});

Deno.test("fully paid requires settlement verified", () => {
  assertEquals(
    isFullyPaidCapturedCoverage({
      customerPayablePence: 793,
      verifiedCapturedTotalPence: 793,
      providerSettlementVerified: false,
    }),
    false,
  );
  assertEquals(
    isFullyPaidCapturedCoverage({
      customerPayablePence: 793,
      verifiedCapturedTotalPence: 793,
      providerSettlementVerified: true,
    }),
    true,
  );
});
