import { describe, expect, it } from "vitest";
import {
  assertActionAllowed,
  computeReleasablePence,
  derivePaymentSessionAllowedActions,
  planPaymentSessionLocalProjectionRepair,
  PAYMENT_ACTION_STALE_REFRESH_REQUIRED,
} from "../../../shared/paymentSessionsAllowedActionsSSOT";

describe("paymentSessionsAllowedActionsSSOT — tab/action correction", () => {
  it("1. No provider hold exists → Release hold hidden", () => {
    const r = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "FAILED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 780,
    });
    expect(r.allowed_actions).not.toContain("release_hold");
    expect(r.can_release).toBe(false);
    expect(["NO_ACTIVE_HOLD", "PROVIDER_ALREADY_RELEASED"]).toContain(r.classification);
  });

  it("2. Provider already released hold → RELEASED_CONFIRMED / PROVIDER_ALREADY_RELEASED", () => {
    const r = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "CANCELLED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 780,
      releasedPence: 780,
    });
    expect(r.classification).toBe("PROVIDER_ALREADY_RELEASED");
    expect(r.classification_label).toContain("RELEASED");
    expect(r.allowed_actions).not.toContain("release_hold");
  });

  it("3. Provider captured payment → CAPTURE_CONFIRMED", () => {
    const r = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "COMPLETED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 780,
      capturedPence: 480,
      canonicalPayablePence: 480,
    });
    expect(r.classification).toBe("CAPTURE_CONFIRMED");
    expect(r.allowed_actions).toEqual([]);
    expect(r.can_retry_recovery).toBe(false);
    expect(r.can_release).toBe(false);
  });

  it("4. Local RELEASE_PENDING but provider says no hold → local state corrected", () => {
    const r = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "CANCELLED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 780,
      localHoldReleaseState: "release_pending",
      localAttentionClass: "RELEASE_PENDING",
      providerReleaseRequestSubmitted: false,
    });
    expect(r.local_state_corrected).toBe("LOCAL_STATE_CORRECTED_FROM_PROVIDER");
    expect(r.classification).not.toBe("RELEASE_PENDING");
    expect(r.allowed_actions).not.toContain("release_hold");
    const repairs = planPaymentSessionLocalProjectionRepair({
      providerState: "CANCELLED",
      providerRetrieved: true,
      localHoldReleaseState: "release_pending",
      localAttentionClass: "RELEASE_PENDING",
      providerReleaseRequestSubmitted: false,
      outstandingPence: 0,
    });
    expect(repairs.some((x) => x.field === "hold_release_state")).toBe(true);
  });

  it("5. Local RECOVERY_PENDING but no outstanding → recovery action removed", () => {
    const r = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "COMPLETED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 780,
      capturedPence: 480,
      canonicalPayablePence: 480,
      localAttentionClass: "RECOVERY_PENDING",
      recoveryCurrentlyPendingOrCaptured: true,
      recoveryAttemptCount: 2,
    });
    expect(r.classification).toBe("CAPTURE_CONFIRMED");
    expect(r.allowed_actions).not.toContain("retry_recovery");
    expect(r.local_state_corrected).toBe("LOCAL_STATE_CORRECTED_FROM_PROVIDER");
  });

  it("6. Provider unreachable → refresh only, no money-moving button", () => {
    const r = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "AUTHORISED",
      providerRetrieved: false,
      providerRetrieveFailed: true,
      providerVerificationStatus: "UNAVAILABLE",
      authorisedPence: 780,
    });
    expect(r.classification).toBe("PROVIDER_REFRESH_REQUIRED");
    expect(r.allowed_actions).toEqual(["refresh_provider_evidence"]);
    expect(r.can_release).toBe(false);
    expect(r.can_retry_recovery).toBe(false);
  });

  it("7. Stale Release hold clicked → PAYMENT_ACTION_STALE_REFRESH_REQUIRED or NO_ACTIVE_HOLD", () => {
    const r = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "CANCELLED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 780,
      localHoldReleaseState: "release_pending",
    });
    const check = assertActionAllowed(r, "release");
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect([
        PAYMENT_ACTION_STALE_REFRESH_REQUIRED,
        "NO_ACTIVE_HOLD",
      ]).toContain((check as { ok: false; error_code: string }).error_code);
    }
  });

  it("8. Active valid hold with zero payable → Release hold shown", () => {
    const r = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "AUTHORISED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 780,
      capturedPence: null,
      releasedPence: null,
      canonicalPayablePence: 0,
      unresolvedFinalCharge: false,
    });
    expect(r.classification).toBe("ACTIVE_AUTHORISATION");
    expect(r.releasable_pence).toBe(780);
    expect(r.allowed_actions).toEqual(["release_hold"]);
  });

  it("9. Active valid hold with no-show fee due → capture fee, not Release hold", () => {
    const r = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "AUTHORISED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 780,
      capturedPence: null,
      canonicalPayablePence: 500,
      unresolvedFinalCharge: true,
    });
    expect(r.allowed_actions).toEqual(["capture_final_amount"]);
    expect(r.allowed_actions).not.toContain("release_hold");
    expect(r.can_release).toBe(false);
    expect(r.can_capture_final).toBe(true);
  });

  it("10. Actual shortfall exists → Collect Outstanding shown", () => {
    const r = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "COMPLETED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 780,
      capturedPence: 480,
      canonicalPayablePence: 698,
      recoveryAttemptCount: 1,
      recoveryAttemptRetryableFailed: true,
      recoveryCurrentlyPendingOrCaptured: false,
    });
    expect(r.classification).toBe("OUTSTANDING_AMOUNT_REQUIRED");
    expect(r.outstanding_pence).toBe(218);
    expect(r.allowed_actions).toContain("collect_outstanding");
    expect(r.allowed_actions).toContain("send_payment_link");
    expect(r.allowed_actions).toContain("retry_recovery");
  });

  it("releasable_pence = auth - captured - released", () => {
    expect(computeReleasablePence({
      authorisedPence: 780,
      capturedPence: 480,
      releasedPence: 100,
    })).toBe(200);
  });

  it("RELEASE_PENDING only when active hold + provider release request id", () => {
    const fake = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "AUTHORISED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 780,
      localHoldReleaseState: "release_pending",
      providerReleaseRequestSubmitted: false,
      canonicalPayablePence: 0,
    });
    expect(fake.classification).not.toBe("RELEASE_PENDING");
    expect(fake.allowed_actions).toContain("release_hold");

    const real = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "AUTHORISED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 780,
      localHoldReleaseState: "release_pending",
      providerReleaseRequestSubmitted: true,
      providerReleaseRequestId: "rel_req_1",
      canonicalPayablePence: 0,
    });
    expect(real.classification).toBe("RELEASE_PENDING");
    expect(real.can_release).toBe(false);
  });

  it("never enable retry_recovery from local RECOVERY_PENDING alone", () => {
    const r = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "COMPLETED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 780,
      capturedPence: 480,
      canonicalPayablePence: 698,
      localAttentionClass: "RECOVERY_PENDING",
      recoveryAttemptCount: 0,
      recoveryAttemptRetryableFailed: false,
    });
    expect(r.allowed_actions).not.toContain("retry_recovery");
    expect(r.allowed_actions).toContain("collect_outstanding");
  });
});
