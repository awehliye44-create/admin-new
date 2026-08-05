import { describe, expect, it } from "vitest";
import {
  computeOutstandingShortfallPence,
  evaluateTripHistoryShortfallRecaptureEligibility,
  isFullyPaidCapturedCoverage,
  paymentCoverageBadgeLabel,
  recaptureActionLabel,
  TRIP_SHORTFALL_RECAPTURE_UI_STATE,
} from "../tripHistoryShortfallRecaptureSSOT";

describe("tripHistoryShortfallRecaptureSSOT", () => {
  it("completed trip with full payment → no recapture / fully paid", () => {
    const gate = evaluateTripHistoryShortfallRecaptureEligibility({
      tripStatus: "completed",
      customerPayablePence: 793,
      verifiedCapturedTotalPence: 793,
      providerSettlementVerified: true,
      adminPermitted: true,
    });
    expect(gate.eligible).toBe(false);
    expect(gate.ui_state).toBe(TRIP_SHORTFALL_RECAPTURE_UI_STATE.FULLY_PAID);
    expect(gate.outstanding_shortfall_pence).toBe(0);
  });

  it("completed trip with £7.93 shortfall → exact £7.93 available", () => {
    const gate = evaluateTripHistoryShortfallRecaptureEligibility({
      tripStatus: "completed",
      paymentMethod: "card",
      customerPayablePence: 793,
      verifiedCapturedTotalPence: 0,
      adminPermitted: true,
    });
    expect(gate.eligible).toBe(true);
    expect(gate.outstanding_shortfall_pence).toBe(793);
    expect(recaptureActionLabel(793)).toBe("Recapture £7.93");
  });

  it("provider canceled is never Fully paid / Captured", () => {
    expect(
      isFullyPaidCapturedCoverage({
        customerPayablePence: 793,
        verifiedCapturedTotalPence: 0,
        providerSettlementVerified: false,
        paymentStatus: "canceled",
        providerStatus: "canceled",
      }),
    ).toBe(false);

    const badge = paymentCoverageBadgeLabel({
      customerPayablePence: 793,
      verifiedCapturedTotalPence: 0,
      providerSettlementVerified: false,
      paymentStatus: "canceled",
      providerStatus: "canceled",
    });
    expect(badge.tone).toBe("canceled");
    expect(badge.label).not.toMatch(/Fully paid/i);
  });

  it("null outstanding / unverified settlement is not fully paid", () => {
    expect(
      isFullyPaidCapturedCoverage({
        customerPayablePence: 793,
        verifiedCapturedTotalPence: null,
        providerSettlementVerified: false,
      }),
    ).toBe(false);
    expect(
      paymentCoverageBadgeLabel({
        customerPayablePence: 793,
        verifiedCapturedTotalPence: null,
        providerSettlementVerified: false,
      }).tone,
    ).not.toBe("fully_paid");
  });

  it("DRIVER_COLLECTED trips cannot recapture", () => {
    const gate = evaluateTripHistoryShortfallRecaptureEligibility({
      tripStatus: "completed",
      financialModel: "DRIVER_COLLECTED_COMMISSION_WALLET",
      customerPayablePence: 793,
      verifiedCapturedTotalPence: 0,
      adminPermitted: true,
    });
    expect(gate.eligible).toBe(false);
    expect(gate.reject_reason).toBe("driver_collected_not_allowed");
  });

  it("unauthorized admin cannot recapture", () => {
    const gate = evaluateTripHistoryShortfallRecaptureEligibility({
      tripStatus: "completed",
      customerPayablePence: 793,
      verifiedCapturedTotalPence: 0,
      adminPermitted: false,
    });
    expect(gate.eligible).toBe(false);
    expect(gate.reject_reason).toBe("admin_not_permitted");
  });

  it("open recovery attempt blocks duplicate", () => {
    const gate = evaluateTripHistoryShortfallRecaptureEligibility({
      tripStatus: "completed",
      customerPayablePence: 793,
      verifiedCapturedTotalPence: 0,
      hasOpenRecoveryAttempt: true,
      adminPermitted: true,
    });
    expect(gate.eligible).toBe(false);
    expect(gate.ui_state).toBe(TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING);
  });

  it("refund reduces effective paid and reopens shortfall", () => {
    expect(
      computeOutstandingShortfallPence({
        customerPayablePence: 793,
        verifiedCapturedTotalPence: 793,
        netRefundedTotalPence: 200,
      }),
    ).toBe(200);
  });

  it("fully paid requires verified settlement AND coverage", () => {
    expect(
      isFullyPaidCapturedCoverage({
        customerPayablePence: 793,
        verifiedCapturedTotalPence: 793,
        providerSettlementVerified: false,
      }),
    ).toBe(false);
    expect(
      isFullyPaidCapturedCoverage({
        customerPayablePence: 793,
        verifiedCapturedTotalPence: 793,
        providerSettlementVerified: true,
      }),
    ).toBe(true);
  });
});
