import { describe, expect, it } from "vitest";
import {
  assertActionAllowed,
  computeReleasablePence,
  derivePaymentSessionAllowedActions,
} from "../paymentSessionsAllowedActionsSSOT";

describe("paymentSessionsAllowedActionsSSOT", () => {
  it("1. local authorised but provider says no hold → no Release hold", () => {
    const r = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "CANCELLED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 780,
      capturedPence: null,
      localHoldReleaseState: null,
    });
    expect(r.classification).toBe("NO_ACTIVE_HOLD");
    expect(r.allowed_actions).toEqual([]);
    expect(r.can_release).toBe(false);
    expect(assertActionAllowed(r, "release").ok).toBe(false);
  });

  it("2. local release_pending without provider release request → clear false pending", () => {
    const r = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "CANCELLED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 780,
      localHoldReleaseState: "release_pending",
      providerReleaseRequestSubmitted: false,
    });
    expect(r.classification).toBe("NO_ACTIVE_HOLD");
    expect(r.local_state_corrected).toBe("LOCAL_STATE_CORRECTED_FROM_PROVIDER");
    expect(r.allowed_actions).not.toContain("release_hold");
  });

  it("3. active provider authorisation with releasable amount → Release hold", () => {
    const r = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "AUTHORISED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 780,
      capturedPence: null,
      releasedPence: null,
    });
    expect(r.classification).toBe("AUTHORISED_ACTIVE");
    expect(r.releasable_pence).toBe(780);
    expect(r.allowed_actions).toContain("release_hold");
    expect(r.can_release).toBe(true);
  });

  it("4. provider authorisation expired / nothing releasable → no release", () => {
    const r = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "AUTHORISED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 0,
      capturedPence: null,
      releasedPence: null,
    });
    expect(r.classification).toBe("AUTHORISATION_EXPIRED");
    expect(r.can_release).toBe(false);
  });

  it("5. provider captured full payable → CAPTURED_CONFIRMED, no recovery", () => {
    const r = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "COMPLETED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 780,
      capturedPence: 480,
      canonicalPayablePence: 480,
    });
    expect(r.classification).toBe("CAPTURED_CONFIRMED");
    expect(r.allowed_actions).toEqual([]);
    expect(r.can_retry_recovery).toBe(false);
    expect(r.can_release).toBe(false);
  });

  it("6. undercapture with failed recovery → Retry recovery", () => {
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
    expect(r.classification).toBe("RECOVERY_REQUIRED");
    expect(r.outstanding_pence).toBe(218);
    expect(r.allowed_actions).toContain("retry_recovery");
    expect(r.allowed_actions).toContain("collect_outstanding");
    expect(r.allowed_actions).toContain("send_payment_link");
  });

  it("7. provider unavailable → PROVIDER_REFRESH_REQUIRED, no destructive action", () => {
    const r = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "AUTHORISED",
      providerRetrieved: false,
      providerRetrieveFailed: true,
      providerVerificationStatus: "UNAVAILABLE",
      authorisedPence: 780,
    });
    expect(r.classification).toBe("PROVIDER_REFRESH_REQUIRED");
    expect(r.allowed_actions).toEqual([]);
    expect(assertActionAllowed(r, "release").ok).toBe(false);
    if (!assertActionAllowed(r, "release").ok) {
      expect(assertActionAllowed(r, "release").error_code).toBe("PROVIDER_REFRESH_REQUIRED");
    }
  });

  it("8. stale page release blocked when provider says no hold", () => {
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
    if (!check.ok) expect(check.error_code).toBe("NO_ACTIVE_HOLD");
  });

  it("releasable_pence = auth - captured - released", () => {
    expect(computeReleasablePence({
      authorisedPence: 780,
      capturedPence: 480,
      releasedPence: 100,
    })).toBe(200);
  });

  it("STALE verification without fresh retrieve → no Release hold", () => {
    const r = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "AUTHORISED",
      providerRetrieved: false,
      providerVerificationStatus: "STALE",
      authorisedPence: 780,
    });
    expect(r.can_release).toBe(false);
    expect(r.classification).toBe("PROVIDER_REFRESH_REQUIRED");
  });

  it("RELEASE_PENDING only when provider release request id exists", () => {
    const fake = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "AUTHORISED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 780,
      localHoldReleaseState: "release_pending",
      providerReleaseRequestSubmitted: false,
    });
    expect(fake.classification).toBe("AUTHORISED_ACTIVE");
    expect(fake.can_release).toBe(true);

    const real = derivePaymentSessionAllowedActions({
      providerOrderId: "ord-1",
      providerState: "AUTHORISED",
      providerRetrieved: true,
      providerVerificationStatus: "VERIFIED",
      authorisedPence: 780,
      localHoldReleaseState: "release_pending",
      providerReleaseRequestSubmitted: true,
      providerReleaseRequestId: "rel_req_1",
    });
    expect(real.classification).toBe("RELEASE_PENDING");
    expect(real.can_release).toBe(false);
  });
});
