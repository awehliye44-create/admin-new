import { describe, expect, it } from "vitest";
import {
  isRecoveryCompletionIdempotent,
  planRecoveryCaptureCompletion,
} from "../paymentSessionsRecoveryCompletionSSOT";
import { earlyCashOutRequiresSettledNotMerelyCaptured } from "../paymentSessionsCaptureConfirmationSSOT";
import { buildPaymentSessionsDisplay } from "../paymentSessionsDisplaySSOT";

describe("paymentSessionsRecoveryCompletionSSOT", () => {
  it("4/5. recovery capture plans trip outstanding 0 + payment_link CAPTURED + no provider_order overwrite", () => {
    const plan = planRecoveryCaptureCompletion({
      recoveryCapturedPence: 218,
      recoverySessionId: "rec-1",
      recoveryProviderOrderId: "ord-recovery",
      parentSessionId: "parent-1",
      parentProviderOrderId: "ord-original",
      originalCapturedPence: 480,
      finalCustomerFarePence: 698,
      paymentProvider: "revolut",
      paymentMethod: "card",
      originalDriverEarningAlreadyCredited: true,
    });

    expect(plan.outstanding_pence).toBe(0);
    expect(plan.total_captured_pence).toBe(698);
    expect(plan.prevent_further_payment_links).toBe(true);
    expect(plan.preserve_original_provider_order_id).toBe(true);
    expect(plan.trip_patch.outstanding_balance_pence).toBe(0);
    expect(plan.trip_patch).not.toHaveProperty("provider_order_id");
    expect(plan.recovery_session_patch.metadata).toMatchObject({
      payment_link_state: "CAPTURED",
      outstanding_closed: true,
    });
    expect(plan.parent_session_patch?.metadata).toMatchObject({
      recovery_completed: true,
      recovery_provider_order_id: "ord-recovery",
      original_provider_order_id: "ord-original",
      total_confirmed_captured_pence: 698,
    });
    expect(plan.wallet.write_driver_credit).toBe(false);
    expect(plan.wallet.clear_finance_risk_only).toBe(true);
  });

  it("7/8. second identical recovery completion is idempotent", () => {
    expect(isRecoveryCompletionIdempotent({
      priorRecoveryStatus: "RECOVERY_COMPLETED",
      priorRecoveryCapturedPence: 218,
      newRecoveryCapturedPence: 218,
    })).toBe(true);

    const a = planRecoveryCaptureCompletion({
      recoveryCapturedPence: 218,
      recoverySessionId: "rec-1",
      recoveryProviderOrderId: "ord-r",
      originalCapturedPence: 480,
      priorRecoveryCapturedPence: 218,
      finalCustomerFarePence: 698,
    });
    const b = planRecoveryCaptureCompletion({
      recoveryCapturedPence: 218,
      recoverySessionId: "rec-1",
      recoveryProviderOrderId: "ord-r",
      originalCapturedPence: 480,
      priorRecoveryCapturedPence: 218,
      finalCustomerFarePence: 698,
    });
    expect(a.outstanding_pence).toBe(0);
    expect(b.outstanding_pence).toBe(0);
    expect(a.total_captured_pence).toBe(b.total_captured_pence);
  });

  it("9. original + recovery equals payable → fully resolved", () => {
    const plan = planRecoveryCaptureCompletion({
      recoveryCapturedPence: 218,
      recoverySessionId: "rec-1",
      recoveryProviderOrderId: "ord-r",
      originalCapturedPence: 480,
      finalCustomerFarePence: 698,
      originalDriverEarningAlreadyCredited: false,
      driverEarningWithheldPendingRecovery: true,
    });
    expect(plan.outstanding_pence).toBe(0);
    expect(plan.wallet.release_withheld_earning).toBe(true);
    expect(plan.wallet.write_driver_credit).toBe(true);
  });

  it("12. captured confirmed label never shows permanent STALE", () => {
    const display = buildPaymentSessionsDisplay({
      raw_session_status: "captured",
      provider_state: "COMPLETED",
      provider_verification_status: "STALE",
      authorised_amount_pence: 780,
      captured_amount_pence: 480,
      released_amount_pence: null,
      refunded_amount_pence: null,
      provider_processing_fee_pence: 12,
      fee_status: "ACTUAL",
      captured_at: "2026-07-12T11:50:00.000Z",
    });
    expect(display.reconciliation_status).toBe("CAPTURED_CONFIRMED");
    expect(display.provider_state_label).toBe("COMPLETED — VERIFIED");
    expect(display.provider_state_label).not.toMatch(/STALE/);
  });

  it("ECO remains settled-gated even when capture confirmed", () => {
    const eco = earlyCashOutRequiresSettledNotMerelyCaptured({
      captureClassification: "CAPTURED_CONFIRMED",
      financeClearedPence: 0,
      settledConfirmed: false,
    });
    expect(eco.early_cash_out_may_use_capture_alone).toBe(false);
    expect(eco.early_cash_out_eligible_from_settlement).toBe(false);
  });
});
