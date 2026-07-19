import { describe, expect, it } from "vitest";
import {
  buildTripPaymentProjectionAfterCapture,
  classifyCaptureConfirmation,
  collectOutstandingActionLabel,
  computeOutstandingBalancePence,
  earlyCashOutRequiresSettledNotMerelyCaptured,
  isHealthyPostCaptureResidualRelease,
  recoveryWalletCreditDecision,
  resolveCanonicalCustomerPayablePence,
  sendPaymentLinkActionLabel,
  shouldOfferCollectOutstanding,
  shouldOfferSendPaymentLink,
  validateCollectOutstandingOrPaymentLinkAction,
} from "../../../shared/paymentSessionsCaptureConfirmationSSOT";
import {
  buildPaymentSessionsDisplay,
  formatReleasedAmountDisplay,
} from "../../../shared/paymentSessionsDisplaySSOT";
import { resolveCaptureAmountToPersist } from "../../../shared/paymentCaptureEvidenceSSOT";

const fmt = (p: number | null) => (p == null ? "—" : `£${(p / 100).toFixed(2)}`);

describe("paymentSessionsCaptureConfirmationSSOT — P0 acceptance", () => {
  it("1. provider captured equals canonical payable → CAPTURED_CONFIRMED, no manual review", () => {
    const result = classifyCaptureConfirmation({
      providerState: "COMPLETED",
      providerCapturedPence: 480,
      localCapturedPence: 480,
      canonicalPayablePence: 480,
    });
    expect(result.classification).toBe("CAPTURED_CONFIRMED");
    expect(result.difference_pence).toBe(0);
    expect(result.requires_manual_review).toBe(false);
    expect(shouldOfferCollectOutstanding({
      classification: result.classification,
      outstandingPence: result.outstanding_pence,
    })).toBe(false);
    expect(shouldOfferSendPaymentLink({
      classification: result.classification,
      outstandingPence: result.outstanding_pence,
    })).toBe(false);
  });

  it("2. local captured null but provider confirms → persist prefers provider; display not manual review once amount known", () => {
    const persist = resolveCaptureAmountToPersist({
      localCapturedAmountPence: null,
      providerCapturedAmountPence: 480,
    });
    expect(persist.amount_pence).toBe(480);
    expect(persist.used_provider).toBe(true);

    const display = buildPaymentSessionsDisplay({
      raw_session_status: "captured",
      provider_state: "COMPLETED",
      provider_verification_status: "STALE",
      authorised_amount_pence: 780,
      captured_amount_pence: 480,
      released_amount_pence: null,
      refunded_amount_pence: null,
      provider_processing_fee_pence: 25,
      fee_status: "ACTUAL",
      captured_at: "2026-07-12T11:50:00.000Z",
      released_at: "2026-07-12T11:50:00.000Z",
    });
    expect(display.reconciliation_status).toBe("CAPTURED_CONFIRMED");
    expect(display.classification).toBe("GREEN");
  });

  it("3. provider captured below final payable → exact outstanding + Collect/Send link", () => {
    const payable = resolveCanonicalCustomerPayablePence({
      finalCustomerFarePence: 698,
      estimatedTotalPence: 480,
    });
    expect(payable.source).toBe("final_customer_fare_pence");
    expect(payable.payable_pence).toBe(698);

    const result = classifyCaptureConfirmation({
      providerState: "COMPLETED",
      providerCapturedPence: 480,
      canonicalPayablePence: payable.payable_pence,
    });
    expect(result.classification).toBe("UNDERCAPTURED_RECOVERY_REQUIRED");
    expect(result.outstanding_pence).toBe(218);
    expect(shouldOfferCollectOutstanding({
      classification: result.classification,
      outstandingPence: result.outstanding_pence,
    })).toBe(true);
    expect(shouldOfferSendPaymentLink({
      classification: result.classification,
      outstandingPence: result.outstanding_pence,
    })).toBe(true);
    expect(collectOutstandingActionLabel(218)).toBe("Collect Outstanding £2.18");
    expect(sendPaymentLinkActionLabel(218)).toBe("Send Payment Link £2.18");
  });

  it("4/5/8. recovery + payment-link capture updates trip projection; wallet not double-credited", () => {
    const projection = buildTripPaymentProjectionAfterCapture({
      canonicalPayablePence: 698,
      totalAuthorisedPence: 780,
      totalCapturedPence: 698,
      paymentProvider: "revolut",
      paymentMethod: "card",
    });
    expect(projection.outstanding_balance_pence).toBe(0);
    expect(projection.payment_coverage_status).toBe("captured");
    expect(projection.capture_amount_pence).toBe(698);

    const wallet = recoveryWalletCreditDecision({
      originalDriverEarningAlreadyCredited: true,
      recoveryCaptureConfirmed: true,
      driverEarningWithheldPendingRecovery: false,
    });
    expect(wallet.write_driver_credit).toBe(false);
    expect(wallet.clear_finance_risk_only).toBe(true);
  });

  it("6. provider captured above payable → overcapture refund workflow", () => {
    const result = classifyCaptureConfirmation({
      providerState: "CAPTURED",
      providerCapturedPence: 780,
      canonicalPayablePence: 480,
    });
    expect(result.classification).toBe("OVERCAPTURED_REFUND_REQUIRED");
    expect(result.difference_pence).toBe(300);
  });

  it("7/8. reconciliation twice / recovery twice → idempotent outstanding and wallet rules", () => {
    const once = computeOutstandingBalancePence({
      canonicalPayablePence: 698,
      confirmedCapturePence: 480,
      confirmedRecoveryCapturePence: 218,
    });
    const twice = computeOutstandingBalancePence({
      canonicalPayablePence: 698,
      confirmedCapturePence: 480,
      confirmedRecoveryCapturePence: 218,
    });
    expect(once).toBe(0);
    expect(twice).toBe(0);

    const safety = validateCollectOutstandingOrPaymentLinkAction({
      outstandingPence: 0,
      alreadyFullyCaptured: true,
      idempotencyKey: "recover:trip:0",
    });
    expect(safety.ok).toBe(false);
    if (!safety.ok) expect((safety as { ok: false; error_code: string }).error_code).toBe("ALREADY_FULLY_CAPTURED");
  });

  it("9. original capture + recovery equals payable → fully resolved", () => {
    expect(computeOutstandingBalancePence({
      canonicalPayablePence: 698,
      confirmedCapturePence: 480,
      confirmedRecoveryCapturePence: 218,
    })).toBe(0);
    const result = classifyCaptureConfirmation({
      providerState: "COMPLETED",
      providerCapturedPence: 698,
      canonicalPayablePence: 698,
    });
    expect(result.classification).toBe("CAPTURED_CONFIRMED");
  });

  it("10. fully captured → no Collect Outstanding or Send Payment Link", () => {
    const result = classifyCaptureConfirmation({
      providerState: "COMPLETED",
      providerCapturedPence: 480,
      canonicalPayablePence: 480,
    });
    expect(shouldOfferCollectOutstanding({
      classification: result.classification,
      outstandingPence: result.outstanding_pence,
    })).toBe(false);
    expect(shouldOfferSendPaymentLink({
      classification: result.classification,
      outstandingPence: result.outstanding_pence,
    })).toBe(false);
    const linkSafety = validateCollectOutstandingOrPaymentLinkAction({
      outstandingPence: 0,
      idempotencyKey: "x",
    });
    expect(linkSafety.ok).toBe(false);
  });

  it("11. actual provider contradiction → manual review with exact reason", () => {
    const result = classifyCaptureConfirmation({
      providerState: "COMPLETED",
      providerCapturedPence: 480,
      canonicalPayablePence: 480,
      currencyMismatch: true,
    });
    expect(result.classification).toBe("MANUAL_REVIEW_REQUIRED");
    expect(result.manual_review_reason).toBe("CURRENCY_MISMATCH");
  });

  it("12. captured but not settled → ECO remains separated from capture confirmation", () => {
    const eco = earlyCashOutRequiresSettledNotMerelyCaptured({
      captureClassification: "CAPTURED_CONFIRMED",
      financeClearedPence: null,
      settledConfirmed: false,
    });
    expect(eco.capture_confirmed).toBe(true);
    expect(eco.settled_confirmed).toBe(false);
    expect(eco.early_cash_out_may_use_capture_alone).toBe(false);
    expect(eco.early_cash_out_eligible_from_settlement).toBe(false);
  });

  it("admin safety: blocks £0 link, over-outstanding, missing idempotency, zero-charge", () => {
    expect(validateCollectOutstandingOrPaymentLinkAction({
      outstandingPence: 218,
      requestedAmountPence: 0,
      idempotencyKey: "k",
    }).ok).toBe(false);
    expect(validateCollectOutstandingOrPaymentLinkAction({
      outstandingPence: 218,
      requestedAmountPence: 500,
      idempotencyKey: "k",
    }).ok).toBe(false);
    expect(validateCollectOutstandingOrPaymentLinkAction({
      outstandingPence: 218,
      idempotencyKey: "",
    }).ok).toBe(false);
    expect(validateCollectOutstandingOrPaymentLinkAction({
      outstandingPence: 218,
      zeroChargeCancellation: true,
      idempotencyKey: "k",
    }).ok).toBe(false);
    const ok = validateCollectOutstandingOrPaymentLinkAction({
      outstandingPence: 218,
      idempotencyKey: "recover:trip:sess:218",
    });
    expect(ok).toEqual({ ok: true, charge_pence: 218 });
  });

  it("residual release + STALE → not DB:AMOUNT_UNCONFIRMED / not permanent STALE error", () => {
    expect(isHealthyPostCaptureResidualRelease({
      providerState: "COMPLETED",
      capturedAmountPence: 480,
      releasedAt: "2026-07-12T11:50:00.000Z",
      releasedAmountPence: null,
      releaseEvidenceStatus: "AMOUNT_UNCONFIRMED",
    })).toBe(true);

    const released = formatReleasedAmountDisplay({
      released_amount_pence: null,
      released_at: "2026-07-12T11:50:00.000Z",
      release_evidence_status: "AMOUNT_UNCONFIRMED",
      currencyFormatter: fmt,
      captureConfirmed: true,
      providerState: "COMPLETED",
      capturedAmountPence: 480,
      expectedReleasePence: 300,
    });
    expect(released.primary).not.toBe("MANUAL_REVIEW_REQUIRED");
    expect(released.secondary).not.toMatch(/DB: AMOUNT_UNCONFIRMED/);
  });

  it("classifies RELEASED / REFUNDED / PAYMENT_LINK_PENDING / PARTIAL", () => {
    expect(classifyCaptureConfirmation({
      releasedAmountPence: 780,
      authorisedPence: 780,
      providerState: "CANCELLED",
    }).classification).toBe("RELEASED_CONFIRMED");

    expect(classifyCaptureConfirmation({
      providerState: "COMPLETED",
      providerCapturedPence: 480,
      refundedAmountPence: 100,
      canonicalPayablePence: 480,
    }).classification).toBe("REFUNDED_CONFIRMED");

    expect(classifyCaptureConfirmation({
      paymentLinkState: "SENT",
      providerCapturedPence: 480,
      canonicalPayablePence: 698,
    }).classification).toBe("PAYMENT_LINK_PENDING");

    expect(classifyCaptureConfirmation({
      providerState: "COMPLETED",
      providerCapturedPence: 480,
      authorisedPence: 780,
    }).classification).toBe("PARTIALLY_CAPTURED_CONFIRMED");
  });
});
