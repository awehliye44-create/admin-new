import { describe, expect, it } from "vitest";
import {
  isCapturedAtRestampSuspect,
  resolvePaymentSessionCaptureAdvanceExtras,
  resolveStablePayoutClearingOriginMs,
} from "../paymentSessionCaptureTimestampSSOT";

describe("paymentSessionCaptureTimestampSSOT", () => {
  it("preserves captured_at on refresh when capture already confirmed", () => {
    expect(resolvePaymentSessionCaptureAdvanceExtras({
      storedCapturedAt: "2026-08-15T10:00:00.000Z",
      storedCapturedAmountPence: 680,
      incomingCapturedAmountPence: 680,
      nowIso: "2026-09-01T20:22:26.000Z",
    })).toEqual({});
  });

  it("uses earliest stable origin when captured_at was restamped", () => {
    expect(isCapturedAtRestampSuspect({
      captured_at: "2026-09-01T20:22:26.000Z",
      trip_completed_at: "2026-08-15T08:00:00.000Z",
      ledger_created_at: "2026-08-15T08:05:00.000Z",
    })).toBe(true);

    expect(resolveStablePayoutClearingOriginMs({
      captured_at: "2026-09-01T20:22:26.000Z",
      trip_completed_at: "2026-08-15T08:00:00.000Z",
      earning_credited_at: "2026-08-15T08:05:00.000Z",
    })).toBe(Date.parse("2026-08-15T08:00:00.000Z"));
  });
});
