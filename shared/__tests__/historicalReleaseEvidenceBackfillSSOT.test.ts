import { describe, expect, it } from "vitest";
import {
  HISTORICAL_RELEASE_EVIDENCE_BACKFILL,
  buildHistoricalReleaseEvidenceIdempotencyKey,
  classifyHistoricalReleaseEvidenceBackfill,
  isEligibleHistoricalReleaseEvidenceSession,
  wouldDowngradeReleaseEvidence,
} from "../historicalReleaseEvidenceBackfillSSOT";

describe("historical release evidence eligibility", () => {
  it("accepts residual NULL release Revolut sessions", () => {
    const r = isEligibleHistoricalReleaseEvidenceSession({
      id: "s1",
      trip_id: "t1",
      payment_provider: "revolut",
      provider_order_id: "ord-1",
      total_authorised_amount_pence: 780,
      captured_amount_pence: 480,
      released_amount_pence: null,
      release_evidence_status: "AMOUNT_UNCONFIRMED",
    });
    expect(r.eligible).toBe(true);
  });

  it("rejects confirmed release with amount", () => {
    const r = isEligibleHistoricalReleaseEvidenceSession({
      id: "s1",
      trip_id: "t1",
      payment_provider: "revolut",
      provider_order_id: "ord-1",
      total_authorised_amount_pence: 780,
      captured_amount_pence: 480,
      released_amount_pence: 300,
      release_evidence_status: "CONFIRMED",
    });
    expect(r.eligible).toBe(false);
  });
});

describe("classifyHistoricalReleaseEvidenceBackfill", () => {
  it("never invents released_amount from auth−capture when COMPLETED without cancelled_amount", () => {
    const r = classifyHistoricalReleaseEvidenceBackfill({
      sessionAuthorisedPence: 780,
      sessionCapturedPence: 480,
      retrieveSucceeded: true,
      providerPayload: {
        state: "COMPLETED",
        order_amount: { value: 480, currency: "GBP" },
        order_outstanding_amount: { value: 0, currency: "GBP" },
        payments: [{
          id: "pay-1",
          state: "COMPLETED",
          amount: { value: 480, currency: "GBP" },
          authorised_amount: { value: 780, currency: "GBP" },
        }],
      },
    });
    expect(r.comparison_auth_minus_capture_pence).toBe(300);
    expect(r.released_amount_pence).toBeNull();
    expect(r.release_evidence_status).toBe("AMOUNT_UNCONFIRMED");
    expect(r.provider_explicit_release_pence).toBeNull();
    expect(r.provider_payment_id).toBe("pay-1");
    expect(r.suggested_alias).toBe("MANUAL_REVIEW_REQUIRED");
    expect(r.unresolved_reason).toBe("terminal_capture_residual_voided_amount_unconfirmed");
  });

  it("CONFIRMED only when provider-explicit cancelled_amount present", () => {
    const r = classifyHistoricalReleaseEvidenceBackfill({
      sessionAuthorisedPence: 780,
      sessionCapturedPence: 480,
      retrieveSucceeded: true,
      providerPayload: {
        state: "COMPLETED",
        cancelled_amount: { value: 300, currency: "GBP" },
        order_amount: { value: 480, currency: "GBP" },
        payments: [{
          id: "pay-2",
          state: "COMPLETED",
          amount: { value: 480, currency: "GBP" },
          authorised_amount: { value: 780, currency: "GBP" },
        }],
      },
    });
    expect(r.release_evidence_status).toBe("CONFIRMED");
    expect(r.released_amount_pence).toBe(300);
    expect(r.suggested_alias).toBe("VERIFIED_RELEASED");
    expect(r.unresolved_reason).toBeNull();
  });

  it("marks ambiguous when provider authorised mismatches session", () => {
    const r = classifyHistoricalReleaseEvidenceBackfill({
      sessionAuthorisedPence: 780,
      sessionCapturedPence: 480,
      retrieveSucceeded: true,
      providerPayload: {
        state: "COMPLETED",
        payments: [{
          id: "pay-3",
          state: "COMPLETED",
          amount: { value: 480, currency: "GBP" },
          authorised_amount: { value: 900, currency: "GBP" },
        }],
      },
    });
    expect(r.match_unambiguous).toBe(false);
    expect(r.released_amount_pence).toBeNull();
    expect(r.suggested_alias).toBe("AMBIGUOUS_PROVIDER_MATCH");
  });
});

describe("idempotency + downgrade guard", () => {
  it("builds stable key with source version", () => {
    const k = buildHistoricalReleaseEvidenceIdempotencyKey({
      sessionId: "sess",
      providerOrderId: "ord",
      capturedAmountPence: 480,
      releaseEvidenceStatus: "AMOUNT_UNCONFIRMED",
    });
    expect(k).toContain(HISTORICAL_RELEASE_EVIDENCE_BACKFILL.VERSION);
    expect(k).toBe(
      "hist_rel_ev:slice9_v1:sess:ord:480:AMOUNT_UNCONFIRMED",
    );
  });

  it("blocks downgrade from CONFIRMED amount", () => {
    expect(wouldDowngradeReleaseEvidence({
      existingStatus: "CONFIRMED",
      existingReleasedAmountPence: 300,
      nextStatus: "AMOUNT_UNCONFIRMED",
      nextReleasedAmountPence: null,
    })).toBe(true);
  });
});
