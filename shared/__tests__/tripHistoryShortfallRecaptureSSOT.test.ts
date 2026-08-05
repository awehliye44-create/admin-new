import { describe, expect, it } from "vitest";
import {
  computeOutstandingShortfallPence,
  evaluateTripHistoryShortfallRecaptureEligibility,
  isFullyPaidCapturedCoverage,
  paymentCoverageBadgeLabel,
  recaptureActionLabel,
  recapturedAmountDisplayLabel,
  rejectClientChargeAmountFields,
  sumVerifiedCapturedFromSessions,
  sumVerifiedRefundedFromSessions,
  TRIP_SHORTFALL_RECAPTURE_UI_STATE,
} from "../tripHistoryShortfallRecaptureSSOT";
import { computeOutstandingBalancePence, recoveryWalletCreditDecision } from "../paymentSessionsCaptureConfirmationSSOT";
import { isRecoveryCompletionIdempotent, planRecoveryCaptureCompletion } from "../paymentSessionsRecoveryCompletionSSOT";

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

  it("arbitrary client amount fields are rejected", () => {
    expect(rejectClientChargeAmountFields({ trip_id: "t1", amount_pence: 9999 }).ok).toBe(false);
    expect(rejectClientChargeAmountFields({ trip_id: "t1" }).ok).toBe(true);
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
    expect(
      paymentCoverageBadgeLabel({
        customerPayablePence: 793,
        verifiedCapturedTotalPence: 0,
        providerSettlementVerified: false,
        paymentStatus: "canceled",
        providerStatus: "canceled",
      }).label,
    ).not.toMatch(/Fully paid/i);
  });

  it("DRIVER_COLLECTED trips cannot recapture", () => {
    expect(
      evaluateTripHistoryShortfallRecaptureEligibility({
        tripStatus: "completed",
        financialModel: "DRIVER_COLLECTED_COMMISSION_WALLET",
        customerPayablePence: 793,
        verifiedCapturedTotalPence: 0,
        adminPermitted: true,
      }).reject_reason,
    ).toBe("driver_collected_not_allowed");
  });

  it("unauthorized admin cannot recapture", () => {
    expect(
      evaluateTripHistoryShortfallRecaptureEligibility({
        tripStatus: "completed",
        customerPayablePence: 793,
        verifiedCapturedTotalPence: 0,
        adminPermitted: false,
      }).reject_reason,
    ).toBe("admin_not_permitted");
  });

  it("refund reduces effective paid and reopens shortfall", () => {
    expect(
      computeOutstandingShortfallPence({
        customerPayablePence: 793,
        verifiedCapturedTotalPence: 793,
        netRefundedTotalPence: 200,
      }),
    ).toBe(200);
    expect(
      computeOutstandingBalancePence({
        canonicalPayablePence: 793,
        confirmedCapturePence: 0,
        confirmedRecoveryCapturePence: 793,
        netRefundedTotalPence: 200,
      }),
    ).toBe(200);
  });

  it("wallet: processing does not credit; already credited does not double", () => {
    expect(
      recoveryWalletCreditDecision({
        originalDriverEarningAlreadyCredited: false,
        recoveryCaptureConfirmed: false,
        driverEarningWithheldPendingRecovery: true,
      }).write_driver_credit,
    ).toBe(false);
    expect(
      recoveryWalletCreditDecision({
        originalDriverEarningAlreadyCredited: true,
        recoveryCaptureConfirmed: true,
        driverEarningWithheldPendingRecovery: false,
      }).write_driver_credit,
    ).toBe(false);
  });

  it("duplicate webhook completion is idempotent; subsequent recovery uses captured", () => {
    expect(
      isRecoveryCompletionIdempotent({
        priorRecoveryStatus: "RECOVERY_COMPLETED",
        priorRecoveryCapturedPence: 793,
        newRecoveryCapturedPence: 793,
      }),
    ).toBe(true);
    const plan = planRecoveryCaptureCompletion({
      recoveryCapturedPence: 200,
      recoverySessionId: "rec-2",
      recoveryProviderOrderId: "ord-2",
      originalCapturedPence: 0,
      priorRecoveryCapturedPence: 793,
      priorCompletedRecoveryExists: true,
      netRefundedTotalPence: 200,
      finalCustomerFarePence: 793,
      originalDriverEarningAlreadyCredited: true,
    });
    expect(plan.recovery_session_patch.status).toBe("captured");
    expect(plan.outstanding_pence).toBe(0);
    expect(recapturedAmountDisplayLabel(793)).toBe("Recaptured £7.93");
    expect(sumVerifiedRefundedFromSessions([{ refunded_amount_pence: 200 }])).toBe(200);
    expect(
      sumVerifiedCapturedFromSessions([
        { purpose: "TRIP_AUTH", status: "canceled", captured_amount_pence: 793 },
      ]).total_verified_captured_pence,
    ).toBe(0);
  });
});
