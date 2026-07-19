import { describe, expect, it } from "vitest";
import {
  canonicalCompanyTransferIdempotencyKey,
  canonicalCompanyTransferProviderRequestId,
  evaluateCompanyTransferPreSubmitGate,
  evaluateCompanyTransferSubmissionEligibility,
  evaluateSlice12SubmissionFlagGate,
  mapCompanyTransferProviderSubmissionOutcome,
  REVOLUT_PAY_REQUEST_ID_MAX_LEN,
  SLICE12_PROOF,
} from "../companyTransferSubmissionSSOT.ts";
import { buildCompanyTransferFundingSnapshot } from "../companyTransferLifecycleSSOT.ts";

describe("companyTransferSubmissionSSOT", () => {
  it("canonical request_id oc-ct:{hex} is ≤40 chars", () => {
    const id = canonicalCompanyTransferProviderRequestId(SLICE12_PROOF.PROOF_TRANSFER_ID);
    expect(id).toBe("oc-ct:4d350ba293e64e4580c9e02bfcf2796b");
    expect(id.length).toBeLessThanOrEqual(REVOLUT_PAY_REQUEST_ID_MAX_LEN);
    expect(canonicalCompanyTransferIdempotencyKey(SLICE12_PROOF.PROOF_TRANSFER_ID)).toBe(id);
  });

  it("evaluateSlice12SubmissionFlagGate requires transport; independent of driver LIVE_PAYOUT", () => {
    expect(evaluateSlice12SubmissionFlagGate({
      get: (k) => ({
        REVOLUT_PAYMENT_TRANSPORT_ENABLED: "true",
        LIVE_PAYOUT_EXECUTION_ENABLED: "false",
      }[k]),
    }).ok).toBe(true);
    expect(evaluateSlice12SubmissionFlagGate({
      get: (k) => ({
        REVOLUT_PAYMENT_TRANSPORT_ENABLED: "false",
        LIVE_PAYOUT_EXECUTION_ENABLED: "false",
      }[k]),
    }).ok).toBe(false);
    // Driver LIVE payout may stay enabled — company path is isolated.
    expect(evaluateSlice12SubmissionFlagGate({
      get: (k) => ({
        REVOLUT_PAYMENT_TRANSPORT_ENABLED: "true",
        LIVE_PAYOUT_EXECUTION_ENABLED: "true",
      }[k]),
    }).ok).toBe(true);
  });

  it("pre-submit gate blocks proof transfer funding snapshot when live disabled", () => {
    const snap = buildCompanyTransferFundingSnapshot({
      capture_phase: "SUBMIT",
      operational_reserve_reason_code: "OPERATIONAL_RESERVE_NOT_CONFIGURED",
      operational_reserve_status: null,
      operational_reserve_pence: null,
      classified_company_cash_pence: 172,
      eligible_company_cash_pence: 525,
      source_balance_pence: 1526,
      final_company_available_pence: null,
    });
    const gate = evaluateCompanyTransferPreSubmitGate({
      amount_pence: 1,
      funding_snapshot: snap,
      live_company_transfer_execution_enabled: false,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason_codes).toContain("OPERATIONAL_RESERVE_NOT_CONFIGURED");
    expect(gate.reason_codes).toContain("FINAL_COMPANY_FUNDS_UNAVAILABLE");
    expect(gate.reason_codes).toContain("UNCLASSIFIED_COMPANY_CASH_PRESENT");
    expect(gate.reason_codes).toContain("LIVE_COMPANY_TRANSFER_EXECUTION_DISABLED");
  });

  it("submission eligibility requires READY_FOR_EXECUTION and linked payee", () => {
    expect(evaluateCompanyTransferSubmissionEligibility({
      transfer_status: "BLOCKED",
      approved_amount_pence: 1,
      loaded_amount_pence: 1,
      provider_counterparty_id: "cp",
      provider_recipient_account_id: "ra",
    }).ok).toBe(false);
    expect(evaluateCompanyTransferSubmissionEligibility({
      transfer_status: "READY_FOR_EXECUTION",
      approved_amount_pence: 1,
      loaded_amount_pence: 1,
      provider_counterparty_id: "cp",
      provider_recipient_account_id: "ra",
    }).ok).toBe(true);
  });

  it("mapCompanyTransferProviderSubmissionOutcome never debits on submit", () => {
    const ok = mapCompanyTransferProviderSubmissionOutcome({
      http_ok: true,
      provider_payment_id: "pay-1",
      provider_state: "pending",
    });
    expect(ok.execution_status).toBe("SUBMITTED");
    expect(ok.company_debited).toBe(false);
    expect(ok.keep_hold_active).toBe(true);
    const fail = mapCompanyTransferProviderSubmissionOutcome({
      http_ok: false,
      provider_state: "failed",
    });
    expect(fail.release_hold).toBe(true);
    expect(fail.company_debited).toBe(false);
  });
});
