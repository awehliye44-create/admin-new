import { describe, expect, it } from "vitest";
import {
  HOLD_RELEASE_BLOCKED_PAYMENT_UNRESOLVED,
  PAYMENT_RESOLUTION_TYPE,
  buildPaymentResolutionPersistPatch,
  canReleaseOriginalHoldAfterRecovery,
  gateHoldReleaseForUnresolvedPayment,
  idempotentCaptureReleaseDecision,
  isGenuinePaymentCancellation,
  markAdditionalAuthPendingOrRecovery,
  planCancellationFeeAgainstAuthorisation,
  planFinalFareAgainstAuthorisation,
  planNoShowFeeAgainstAuthorisation,
} from "../finalFareAuthorisationSSOT";

describe("planFinalFareAgainstAuthorisation", () => {
  it("A: final fare equals authorised → full capture", () => {
    const plan = planFinalFareAgainstAuthorisation({
      originalAuthorisedPence: 1089,
      finalChargePence: 1089,
    });
    expect(plan.payment_resolution_type).toBe(PAYMENT_RESOLUTION_TYPE.FULL_CAPTURE);
    expect(plan.keep_original_hold).toBe(true);
    expect(plan.money).toMatchObject({
      original_authorised_pence: 1089,
      captured_pence: 1089,
      released_pence: 0,
      shortfall_pence: 0,
    });
  });

  it("B: final fare lower → partial capture + release remainder", () => {
    const plan = planFinalFareAgainstAuthorisation({
      originalAuthorisedPence: 1089,
      finalChargePence: 750,
    });
    expect(plan.payment_resolution_type).toBe(
      PAYMENT_RESOLUTION_TYPE.PARTIAL_CAPTURE_RELEASE_REMAINDER,
    );
    expect(plan.keep_original_hold).toBe(true);
    expect(plan.money).toMatchObject({
      original_authorised_pence: 1089,
      captured_pence: 750,
      released_pence: 339,
      total_authorised_pence: 1089,
    });
  });

  it("C: final fare higher → keep original + additional auth shortfall", () => {
    const plan = planFinalFareAgainstAuthorisation({
      originalAuthorisedPence: 1089,
      finalChargePence: 1388,
    });
    expect(plan.payment_resolution_type).toBe(
      PAYMENT_RESOLUTION_TYPE.ADDITIONAL_AUTHORISATION,
    );
    expect(plan.keep_original_hold).toBe(true);
    expect(plan.additional_authorisation_pence).toBe(299);
    expect(plan.capture_from_original_pence).toBe(1089);
    expect(plan.money.shortfall_pence).toBe(299);
  });

  it("waiting charge shortfall uses additional auth", () => {
    // authorised 1000, final 1000 + waiting 200 = 1200
    const plan = planFinalFareAgainstAuthorisation({
      originalAuthorisedPence: 1000,
      finalChargePence: 1200,
    });
    expect(plan.money.shortfall_pence).toBe(200);
    expect(plan.keep_original_hold).toBe(true);
  });

  it("additional auth SCA pending / failed keeps original hold + PAYMENT_RECOVERY_REQUIRED", () => {
    const base = planFinalFareAgainstAuthorisation({
      originalAuthorisedPence: 1089,
      finalChargePence: 1388,
    });
    const pending = markAdditionalAuthPendingOrRecovery(base, "pending_sca");
    expect(pending.keep_original_hold).toBe(true);
    expect(pending.recovery_required).toBe(true);
    expect(pending.payment_resolution_type).toBe(PAYMENT_RESOLUTION_TYPE.PAYMENT_RECOVERY);
    expect(pending.ui_label).toBe("Payment recovery required");

    const failed = markAdditionalAuthPendingOrRecovery(base, "failed");
    expect(failed.keep_original_hold).toBe(true);
    expect(failed.recovery_required).toBe(true);
    expect(failed.payment_resolution_type).toBe(PAYMENT_RESOLUTION_TYPE.PAYMENT_RECOVERY);
    expect(failed.ui_label).toBe("Payment recovery required");
  });
});

describe("no-show and cancellation fee plans", () => {
  it("D: no-show fee lower than hold → capture fee + release remainder", () => {
    const plan = planNoShowFeeAgainstAuthorisation({
      originalAuthorisedPence: 1089,
      noShowFeePence: 500,
    });
    expect(plan.payment_resolution_type).toBe(PAYMENT_RESOLUTION_TYPE.NO_SHOW_FEE_CAPTURE);
    expect(plan.money).toMatchObject({
      captured_pence: 500,
      released_pence: 589,
      no_show_fee_pence: 500,
    });
    expect(plan.keep_original_hold).toBe(true);
  });

  it("E: cancellation fee lower than hold", () => {
    const plan = planCancellationFeeAgainstAuthorisation({
      originalAuthorisedPence: 1089,
      cancellationFeePence: 300,
    });
    expect(plan.payment_resolution_type).toBe(
      PAYMENT_RESOLUTION_TYPE.CANCELLATION_FEE_CAPTURE,
    );
    expect(plan.money).toMatchObject({
      captured_pence: 300,
      released_pence: 789,
      cancellation_fee_pence: 300,
    });
  });

  it("F: zero-charge cancellation → full release", () => {
    const plan = planCancellationFeeAgainstAuthorisation({
      originalAuthorisedPence: 1089,
      cancellationFeePence: 0,
    });
    expect(plan.payment_resolution_type).toBe(
      PAYMENT_RESOLUTION_TYPE.FULL_RELEASE_ZERO_CHARGE,
    );
    expect(plan.money.released_pence).toBe(1089);
    expect(plan.money.captured_pence).toBe(0);
    expect(plan.ui_label).toBe("Fully released — no charge");
  });
});

describe("gateHoldReleaseForUnresolvedPayment", () => {
  it("blocks completed trip with unresolved capture", () => {
    const gate = gateHoldReleaseForUnresolvedPayment({
      tripStatus: "completed",
      finalFarePence: 1388,
      capturedAmountPence: 0,
      paymentHoldStatus: "authorised_hold",
    });
    expect(gate.allow).toBe(false);
    if (!gate.allow) {
      expect(gate.code).toBe(HOLD_RELEASE_BLOCKED_PAYMENT_UNRESOLVED);
    }
  });

  it("blocks payment recovery / shortfall", () => {
    expect(
      gateHoldReleaseForUnresolvedPayment({
        tripStatus: "completed",
        recoveryRequired: true,
      }).allow,
    ).toBe(false);
    expect(
      gateHoldReleaseForUnresolvedPayment({
        tripStatus: "completed",
        paymentHoldStatus: "payment_shortfall",
        finalFarePence: 1000,
      }).allow,
    ).toBe(false);
  });

  it("allows zero-charge cancellation release", () => {
    expect(
      gateHoldReleaseForUnresolvedPayment({
        tripStatus: "customer_cancelled",
        cancellationFeePence: 0,
        finalFarePence: 0,
        capturedAmountPence: 0,
      }).allow,
    ).toBe(true);
  });

  it("idempotent duplicate gate stays blocked while unresolved", () => {
    const a = gateHoldReleaseForUnresolvedPayment({
      tripStatus: "no_show",
      noShowFeePence: 500,
      capturedAmountPence: 0,
    });
    const b = gateHoldReleaseForUnresolvedPayment({
      tripStatus: "no_show",
      noShowFeePence: 500,
      capturedAmountPence: 0,
    });
    expect(a).toEqual(b);
    expect(a.allow).toBe(false);
  });
});

describe("isGenuinePaymentCancellation", () => {
  it("intentional release with released_at is not Cancelled", () => {
    expect(
      isGenuinePaymentCancellation({
        rawSessionStatus: "cancelled",
        providerState: "CANCELLED",
        releasedAt: "2026-07-17T00:00:00Z",
        releasedAmountPence: 1089,
        paymentResolutionType: PAYMENT_RESOLUTION_TYPE.FULL_RELEASE_ZERO_CHARGE,
      }),
    ).toBe(false);
  });

  it("provider cancel with no release evidence is genuine cancel", () => {
    expect(
      isGenuinePaymentCancellation({
        rawSessionStatus: "cancelled",
        providerState: "CANCELLED",
        releasedAt: null,
        releasedAmountPence: null,
        capturedAmountPence: null,
      }),
    ).toBe(true);
  });
});

describe("recovery then original hold release + idempotency", () => {
  it("11: recovery charge succeeds then original hold may be released", () => {
    const before = canReleaseOriginalHoldAfterRecovery({
      recoveryCapturedPence: 0,
      finalChargePence: 1388,
      originalHoldStillActive: true,
    });
    expect(before.allow).toBe(false);

    const after = canReleaseOriginalHoldAfterRecovery({
      recoveryCapturedPence: 1388,
      finalChargePence: 1388,
      originalHoldStillActive: true,
    });
    expect(after.allow).toBe(true);
    if (after.allow) {
      expect(after.release_original).toBe(true);
    }

    // Sweep still blocks while recovery incomplete.
    expect(
      gateHoldReleaseForUnresolvedPayment({
        tripStatus: "completed",
        recoveryRequired: true,
        finalFarePence: 1388,
        capturedAmountPence: 0,
      }).allow,
    ).toBe(false);
  });

  it("12: duplicate capture/release decisions stay idempotent", () => {
    const first = idempotentCaptureReleaseDecision({
      originalAuthorisedPence: 1089,
      finalChargePence: 750,
    });
    expect(first.capture_pence).toBe(750);
    expect(first.release_pence).toBe(339);
    expect(first.already_complete).toBe(false);

    const second = idempotentCaptureReleaseDecision({
      originalAuthorisedPence: 1089,
      finalChargePence: 750,
      alreadyCapturedPence: 750,
      alreadyReleasedPence: 339,
    });
    expect(second.capture_pence).toBe(0);
    expect(second.release_pence).toBe(0);
    expect(second.already_complete).toBe(true);
    expect(second.plan.money).toEqual(first.plan.money);

    const patch = buildPaymentResolutionPersistPatch(first.plan);
    expect(patch).toMatchObject({
      original_authorised_pence: 1089,
      captured_amount_pence: 750,
      released_amount_pence: 339,
      payment_resolution_type: PAYMENT_RESOLUTION_TYPE.PARTIAL_CAPTURE_RELEASE_REMAINDER,
    });
  });
});
