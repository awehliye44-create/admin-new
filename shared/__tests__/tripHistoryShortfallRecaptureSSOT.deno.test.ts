/**
 * Deno-compatible unit tests for tripHistoryShortfallRecaptureSSOT.
 * Run: deno test --allow-read --no-check shared/__tests__/tripHistoryShortfallRecaptureSSOT.deno.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeOutstandingShortfallPence,
  deriveAdminRecaptureOutcome,
  evaluateTripHistoryShortfallRecaptureEligibility,
  isFullyPaidCapturedCoverage,
  paymentCoverageBadgeLabel,
  recaptureActionLabel,
  recaptureAttemptBadgeLabel,
  recapturedAmountDisplayLabel,
  rejectClientChargeAmountFields,
  resolveRecaptureAttemptUi,
  sumVerifiedCapturedFromSessions,
  sumVerifiedRefundedFromSessions,
  TRIP_SHORTFALL_RECAPTURE_UI_STATE,
} from "../tripHistoryShortfallRecaptureSSOT.ts";
import { computeOutstandingBalancePence } from "../paymentSessionsCaptureConfirmationSSOT.ts";
import {
  planRecoveryCaptureCompletion,
  isRecoveryCompletionIdempotent,
} from "../paymentSessionsRecoveryCompletionSSOT.ts";
import { recoveryWalletCreditDecision } from "../paymentSessionsCaptureConfirmationSSOT.ts";

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

Deno.test("arbitrary client amount rejected", () => {
  assertEquals(rejectClientChargeAmountFields({ trip_id: "t1", amount_pence: 9999 }).ok, false);
  assertEquals(rejectClientChargeAmountFields({ trip_id: "t1" }).ok, true);
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

Deno.test("open recovery blocks duplicate UI initiation", () => {
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
  assertEquals(
    computeOutstandingBalancePence({
      canonicalPayablePence: 793,
      confirmedCapturePence: 0,
      confirmedRecoveryCapturePence: 793,
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

Deno.test("verified sum excludes canceled and labels Recaptured", () => {
  const sum = sumVerifiedCapturedFromSessions([
    { purpose: "TRIP_AUTH", status: "canceled", captured_amount_pence: 793 },
    { purpose: "PAYMENT_RECOVERY", status: "recovery_completed", provider_state: "completed", captured_amount_pence: 793 },
  ]);
  assertEquals(sum.original_captured_pence, 0);
  assertEquals(sum.recaptured_pence, 793);
  assertEquals(recapturedAmountDisplayLabel(793), "Recaptured £7.93");
  assertEquals(sumVerifiedRefundedFromSessions([{ refunded_amount_pence: 200 }]), 200);
});

Deno.test("processing recovery does not credit wallet", () => {
  const wallet = recoveryWalletCreditDecision({
    originalDriverEarningAlreadyCredited: false,
    recoveryCaptureConfirmed: false,
    driverEarningWithheldPendingRecovery: true,
  });
  assertEquals(wallet.write_driver_credit, false);
});

Deno.test("already-credited driver is not credited twice", () => {
  const wallet = recoveryWalletCreditDecision({
    originalDriverEarningAlreadyCredited: true,
    recoveryCaptureConfirmed: true,
    driverEarningWithheldPendingRecovery: false,
  });
  assertEquals(wallet.write_driver_credit, false);
  assertEquals(wallet.clear_finance_risk_only, true);
});

Deno.test("duplicate recovery webhook completion is idempotent", () => {
  assertEquals(
    isRecoveryCompletionIdempotent({
      priorRecoveryStatus: "RECOVERY_COMPLETED",
      priorRecoveryCapturedPence: 793,
      newRecoveryCapturedPence: 793,
    }),
    true,
  );
  const planA = planRecoveryCaptureCompletion({
    recoveryCapturedPence: 793,
    recoverySessionId: "rec-1",
    recoveryProviderOrderId: "ord-1",
    originalCapturedPence: 0,
    priorRecoveryCapturedPence: 0,
    finalCustomerFarePence: 793,
    originalDriverEarningAlreadyCredited: true,
  });
  const planB = planRecoveryCaptureCompletion({
    recoveryCapturedPence: 793,
    recoverySessionId: "rec-1",
    recoveryProviderOrderId: "ord-1",
    originalCapturedPence: 0,
    priorRecoveryCapturedPence: 793,
    finalCustomerFarePence: 793,
    originalDriverEarningAlreadyCredited: true,
  });
  assertEquals(planA.outstanding_pence, 0);
  assertEquals(planB.outstanding_pence, 0);
  assertEquals(planA.total_captured_pence, planB.total_captured_pence);
  assertEquals(planA.wallet.write_driver_credit, false);
});

Deno.test("subsequent recovery after prior completed uses captured status", () => {
  // Prior recovery £7.93 completed, then £2.00 refunded → new £2.00 recovery closes shortfall.
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
  assertEquals(plan.recovery_session_patch.status, "captured");
  assertEquals(plan.outstanding_pence, 0);
  assertEquals(plan.total_captured_pence, 993);
});

Deno.test("£4 saved-card success with leftover checkout_url is not customer action", () => {
  const outcome = deriveAdminRecaptureOutcome({
    saved_card_charged: true,
    requires_customer_action: false,
    checkout_url: "https://checkout.revolut.com/pay/recover-4",
    status: "RECOVERY_CHECKOUT_CREATED",
  });
  assertEquals(outcome.saved_card_charged, true);
  assertEquals(outcome.requires_customer_action, false);
  assertEquals(outcome.show_payment_link, false);
  assertEquals(outcome.status, TRIP_SHORTFALL_RECAPTURE_UI_STATE.SAVED_CARD_CHARGED);
  assertEquals(recaptureAttemptBadgeLabel(outcome.status), "Saved card charged");
});

Deno.test("processing is not overridden by a stale open recovery session", () => {
  const ui = resolveRecaptureAttemptUi({
    attemptState: TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING,
    hasOpenRecoverySession: true,
    gateUiState: TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_AVAILABLE,
  });
  assertEquals(ui.ui_state, TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING);
  assertEquals(ui.show_payment_link, false);
});
