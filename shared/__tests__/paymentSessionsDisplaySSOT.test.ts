import { describe, expect, it } from "vitest";
import {
  buildPaymentSessionsDisplay,
  deriveFeeDisplay,
  mapCanonicalSessionStatus,
  rowBelongsInActiveHoldsTab,
  rowBelongsInCapturedTab,
} from "../paymentSessionsDisplaySSOT";
import {
  extractConfirmedCaptureAmountPence,
  extractProviderCaptureId,
} from "../paymentHoldProviderTerminalPure";
import { classifyPaymentHoldAttention } from "../paymentHoldClassificationSSOT";

describe("capture amount extractors", () => {
  it("reads explicit captured_amount and COMPLETED order amount", () => {
    expect(extractConfirmedCaptureAmountPence({ captured_amount: 780 }, "CAPTURED")).toBe(780);
    expect(extractConfirmedCaptureAmountPence({ amount: 780 }, "COMPLETED")).toBe(780);
    expect(extractConfirmedCaptureAmountPence({ amount: 780 }, "AUTHORISED")).toBeNull();
    expect(extractProviderCaptureId({ capture_id: "cap_1" })).toBe("cap_1");
  });

  it("reads Revolut payments[].amount.value and order_amount objects", () => {
    expect(extractConfirmedCaptureAmountPence({
      state: "COMPLETED",
      order_amount: { value: 780, currency: "GBP" },
      payments: [{ id: "pay_1", state: "COMPLETED", amount: { value: 480, currency: "GBP" } }],
    }, "COMPLETED")).toBe(480);
    expect(extractConfirmedCaptureAmountPence({
      state: "COMPLETED",
      order_amount: { value: 780, currency: "GBP" },
    }, "COMPLETED")).toBe(780);
  });
});

describe("paymentSessionsDisplaySSOT", () => {
  it("maps provider CAPTURED + amount present to CAPTURED / COMPLETE / GREEN", () => {
    const display = buildPaymentSessionsDisplay({
      raw_session_status: "completed_pending_capture",
      provider_state: "CAPTURED",
      provider_verification_status: "VERIFIED",
      authorised_amount_pence: 780,
      captured_amount_pence: 780,
      released_amount_pence: null,
      refunded_amount_pence: null,
      provider_processing_fee_pence: 12,
      fee_status: "ACTUAL",
      captured_at: "2026-07-10T12:00:00.000Z",
    });
    expect(display.session_status_display).toBe("CAPTURED");
    expect(display.evidence_status).toBe("COMPLETE");
    expect(display.reconciliation_status).toBe("CAPTURED_CONFIRMED");
    expect(display.session_status_label).toBe("CAPTURED — CONFIRMED");
    expect(display.classification).toBe("GREEN");
    expect(display.provider_state_label).toContain("CAPTURED");
    expect(display.provider_state_label).toContain("VERIFIED");
    expect(display.provider_state_label).toContain("—");
  });

  it("maps provider CAPTURED + missing amount to evidence pending / AMBER", () => {
    const display = buildPaymentSessionsDisplay({
      raw_session_status: "completed_pending_capture",
      provider_state: "CAPTURED",
      provider_verification_status: "VERIFIED",
      authorised_amount_pence: 780,
      captured_amount_pence: null,
      released_amount_pence: null,
      refunded_amount_pence: null,
      provider_processing_fee_pence: null,
      fee_status: null,
      captured_at: "2026-07-10T12:00:00.000Z",
    });
    expect(display.session_status_display).toBe("CAPTURED_EVIDENCE_PENDING");
    expect(display.session_status_label).toBe("CAPTURED EVIDENCE PENDING");
    expect(display.evidence_status).toBe("CAPTURE_AMOUNT_MISSING");
    expect(display.reconciliation_status).toBe("ATTENTION_CAPTURE_AMOUNT_MISSING");
    expect(display.classification).toBe("AMBER");
  });

  it("maps completed_pending_capture without provider capture to CAPTURE_PENDING", () => {
    expect(mapCanonicalSessionStatus({
      raw_session_status: "completed_pending_capture",
      provider_state: "AUTHORISED",
      authorised_amount_pence: 780,
      captured_amount_pence: null,
      released_amount_pence: null,
      refunded_amount_pence: null,
      provider_processing_fee_pence: null,
      fee_status: null,
    })).toBe("CAPTURE_PENDING");
  });

  it("never treats null fee as £0", () => {
    const fee = deriveFeeDisplay({
      provider_processing_fee_pence: null,
      fee_status: "PENDING",
    });
    expect(fee.amount_pence).toBeNull();
    expect(fee.label).toBe("Pending provider fee");
    expect(fee.badge).toBe("PENDING");
  });

  it("Captured tab requires confirmed amount; unconfirmed stays out of Captured", () => {
    const unconfirmed = {
      captured_at: "2026-07-10T12:00:00.000Z",
      captured_amount_pence: null as number | null,
      provider_state: "CAPTURED",
      in_active_queue: true,
      classification: "AMBER",
      attention_class: "CAPTURED",
    };
    expect(rowBelongsInCapturedTab(unconfirmed)).toBe(false);
    expect(rowBelongsInActiveHoldsTab(unconfirmed)).toBe(false);

    const confirmed = { ...unconfirmed, captured_amount_pence: 780 };
    expect(rowBelongsInCapturedTab(confirmed)).toBe(true);
    expect(rowBelongsInActiveHoldsTab(confirmed)).toBe(false);
  });

  it("maps intentional cancelled+released_at as RELEASED not CANCELLED", () => {
    expect(mapCanonicalSessionStatus({
      raw_session_status: "cancelled",
      provider_state: "CANCELLED",
      authorised_amount_pence: 780,
      captured_amount_pence: null,
      released_amount_pence: 780,
      refunded_amount_pence: null,
      provider_processing_fee_pence: null,
      fee_status: null,
      released_at: "2026-07-10T12:00:00.000Z",
    })).toBe("RELEASED");

    expect(mapCanonicalSessionStatus({
      raw_session_status: "released",
      provider_state: "REVERTED",
      authorised_amount_pence: 780,
      captured_amount_pence: null,
      released_amount_pence: 780,
      refunded_amount_pence: null,
      provider_processing_fee_pence: null,
      fee_status: null,
      released_at: "2026-07-10T12:00:00.000Z",
    })).toBe("RELEASED");
  });

  it("maps genuine cancel without release evidence as CANCELLED", () => {
    expect(mapCanonicalSessionStatus({
      raw_session_status: "cancelled",
      provider_state: "CANCELLED",
      authorised_amount_pence: 780,
      captured_amount_pence: null,
      released_amount_pence: null,
      refunded_amount_pence: null,
      provider_processing_fee_pence: null,
      fee_status: null,
      released_at: null,
    })).toBe("CANCELLED");
  });

  it("Active Holds includes healthy live authorisations (GREEN / OK trip)", () => {
    expect(rowBelongsInActiveHoldsTab({
      in_active_queue: false,
      classification: "GREEN",
      provider_state: "AUTHORISED",
      authorised_amount_pence: 780,
      captured_amount_pence: null,
      captured_at: null,
      released_at: null,
      refunded_at: null,
      attention_class: "OK_ACTIVE_TRIP",
      session_status_display: "AUTHORISED",
    })).toBe(true);
  });

  it("maps capture_failed raw status to CAPTURE_FAILED", () => {
    expect(mapCanonicalSessionStatus({
      raw_session_status: "capture_failed",
      provider_state: "FAILED",
      authorised_amount_pence: 780,
      captured_amount_pence: null,
      released_amount_pence: null,
      refunded_amount_pence: null,
      provider_processing_fee_pence: null,
      fee_status: null,
    })).toBe("CAPTURE_FAILED");
  });

  it("marks captured+pending fee as PENDING_PROVIDER_FEE not fully balanced", () => {
    const display = buildPaymentSessionsDisplay({
      raw_session_status: "captured",
      provider_state: "CAPTURED",
      provider_verification_status: "VERIFIED",
      authorised_amount_pence: 780,
      captured_amount_pence: 780,
      released_amount_pence: null,
      refunded_amount_pence: null,
      provider_processing_fee_pence: null,
      fee_status: "PENDING",
      captured_at: "2026-07-10T12:00:00.000Z",
    });
    expect(display.evidence_status).toBe("PENDING_PROVIDER_FEE");
    expect(display.reconciliation_status).toBe("PENDING_PROVIDER_FEE");
    expect(display.classification).toBe("AMBER");
  });
});

describe("classifyPaymentHoldAttention capture evidence", () => {
  it("does not GREEN provider CAPTURED when captured amount is missing", () => {
    const result = classifyPaymentHoldAttention({
      sessionStatus: "completed_pending_capture",
      tripStatus: "completed",
      paymentHoldStatus: "captured",
      releasedAt: null,
      capturedAt: "2026-07-10T12:00:00.000Z",
      capturedAmountPence: null,
      feeStatus: null,
      tripId: "trip-1",
      ageMinutes: 10,
      releaseFailureReason: null,
      providerOrderState: "CAPTURED",
    });
    expect(result.attention_class).toBe("CAPTURED");
    expect(result.classification).toBe("AMBER");
    expect(result.in_active_queue).toBe(false);
  });

  it("GREEN only when amount and fee evidence are complete", () => {
    const result = classifyPaymentHoldAttention({
      sessionStatus: "captured",
      tripStatus: "completed",
      paymentHoldStatus: "captured",
      releasedAt: null,
      capturedAt: "2026-07-10T12:00:00.000Z",
      capturedAmountPence: 780,
      feeStatus: "ACTUAL",
      tripId: "trip-1",
      ageMinutes: 10,
      releaseFailureReason: null,
      providerOrderState: "CAPTURED",
    });
    expect(result.classification).toBe("GREEN");
  });
});

describe("never emit vague INCOMPLETE", () => {
  it("evidence status uses LOCAL_BACKFILL_REQUIRED instead of INCOMPLETE", () => {
    const display = buildPaymentSessionsDisplay({
      raw_session_status: "trip_created",
      provider_state: null,
      provider_verification_status: "UNKNOWN",
      authorised_amount_pence: null,
      captured_amount_pence: null,
      released_amount_pence: null,
      refunded_amount_pence: null,
      provider_processing_fee_pence: null,
      fee_status: null,
      captured_at: null,
      released_at: null,
      refunded_at: null,
    });
    expect(display.evidence_status).toBe("LOCAL_BACKFILL_REQUIRED");
    expect(display.evidence_status).not.toBe("INCOMPLETE");
    expect(String(display.evidence_label).toUpperCase()).not.toContain("INCOMPLETE");
    expect(String(display.session_status_label).toUpperCase()).not.toContain("INCOMPLETE");
  });
});
