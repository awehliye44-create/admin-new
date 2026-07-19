import { describe, expect, it } from "vitest";
import {
  completionDebitIdempotencyKey,
  evaluateCompanyTransferCompletionEligibility,
  evaluateSlice12CompletionFlagGate,
  isCanonicalProviderCompleted,
  mayFinaliseCompanyTransferFromProviderState,
  mapProviderReversalOutcome,
} from "../companyTransferCompletionSSOT.ts";

describe("companyTransferCompletionSSOT", () => {
  it("only completed may finalise", () => {
    expect(isCanonicalProviderCompleted("completed")).toBe(true);
    expect(mayFinaliseCompanyTransferFromProviderState("pending").ok).toBe(false);
    expect(mayFinaliseCompanyTransferFromProviderState("completed").ok).toBe(true);
  });

  it("evaluateSlice12CompletionFlagGate is independent of driver LIVE_PAYOUT", () => {
    expect(evaluateSlice12CompletionFlagGate({
      get: (k) => ({ LIVE_PAYOUT_EXECUTION_ENABLED: "false" }[k]),
    }).ok).toBe(true);
    expect(evaluateSlice12CompletionFlagGate({
      get: (k) => ({ LIVE_PAYOUT_EXECUTION_ENABLED: "true" }[k]),
    }).ok).toBe(true);
  });

  it("completion eligibility requires submitted intent and active hold", () => {
    expect(evaluateCompanyTransferCompletionEligibility({
      transfer_status: "PROCESSING",
      intent_status: "SUBMITTED",
      hold_status: "ACTIVE",
      transfer_amount_pence: 1,
      hold_amount_pence: 1,
      intent_amount_pence: 1,
      currency: "GBP",
      intent_provider_payment_id: "pay-1",
    }).ok).toBe(true);
    expect(evaluateCompanyTransferCompletionEligibility({
      transfer_status: "BLOCKED",
      intent_status: "SUBMITTED",
      hold_status: "ACTIVE",
      transfer_amount_pence: 1,
      hold_amount_pence: 1,
      intent_amount_pence: 1,
      currency: "GBP",
    }).ok).toBe(false);
  });

  it("completionDebitIdempotencyKey is stable per provider payment id", () => {
    expect(completionDebitIdempotencyKey("abc-123")).toBe(
      "revolut-company-transfer-completion:abc-123",
    );
  });

  it("mapProviderReversalOutcome releases hold on reverted", () => {
    const rev = mapProviderReversalOutcome({ provider_state: "reverted" });
    expect(rev.transfer_status).toBe("REVERTED");
    expect(rev.release_hold).toBe(true);
    expect(rev.restore_funding).toBe(true);
  });
});
