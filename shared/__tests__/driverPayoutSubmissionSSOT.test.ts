import { describe, expect, it } from "vitest";
import {
  ADMIN_SLICE7_LABELS,
  SLICE7_PROOF_DRIVERS,
  SUBMISSION_ERROR,
  adminItemSubmissionDisplay,
  assertSlice7MoneySafety,
  evaluateSlice7FlagGate,
  evaluateSourceAccountGate,
  evaluateSubmissionEligibility,
  mapProviderSubmissionOutcome,
  maskProviderId,
  maySubmitReservedDriverPayoutViaTransport,
  rejectCompanyOrArbitraryPayment,
} from "../driverPayoutSubmissionSSOT.ts";

describe("Slice 7 submission SSOT", () => {
  it("allows submission when TRANSPORT=true (LIVE may be true for orchestrator)", () => {
    expect(maySubmitReservedDriverPayoutViaTransport({
      get: (k) =>
        k === "REVOLUT_PAYMENT_TRANSPORT_ENABLED"
          ? "true"
          : k === "LIVE_PAYOUT_EXECUTION_ENABLED"
          ? "false"
          : undefined,
    })).toBe(true);
    expect(evaluateSlice7FlagGate({
      get: (k) =>
        k === "REVOLUT_PAYMENT_TRANSPORT_ENABLED"
          ? "true"
          : k === "LIVE_PAYOUT_EXECUTION_ENABLED"
          ? "true"
          : undefined,
    }).ok).toBe(true);
    expect(evaluateSlice7FlagGate({
      get: (k) =>
        k === "REVOLUT_PAYMENT_TRANSPORT_ENABLED"
          ? "false"
          : k === "LIVE_PAYOUT_EXECUTION_ENABLED"
          ? "false"
          : undefined,
    })).toMatchObject({ code: SUBMISSION_ERROR.PAYMENT_TRANSPORT_DISABLED });
  });

  it("gates source account: GBP + sufficient balance + configured", () => {
    expect(evaluateSourceAccountGate({
      source_account_id: null,
      currency: "GBP",
      available_pence: 10000,
      amount_pence: 408,
    }).ok).toBe(false);
    expect(evaluateSourceAccountGate({
      source_account_id: "acct-1",
      currency: "EUR",
      available_pence: 10000,
      amount_pence: 408,
    })).toMatchObject({ code: SUBMISSION_ERROR.SOURCE_ACCOUNT_NOT_GBP });
    expect(evaluateSourceAccountGate({
      source_account_id: "acct-1",
      currency: "GBP",
      available_pence: 100,
      amount_pence: 408,
    })).toMatchObject({ code: SUBMISSION_ERROR.INSUFFICIENT_SOURCE_BALANCE });
    expect(evaluateSourceAccountGate({
      source_account_id: "acct-1",
      currency: "GBP",
      available_pence: 408,
      amount_pence: 408,
    })).toMatchObject({ ok: true, source_account_id: "acct-1" });
  });

  it("requires RESERVED + ACTIVE reservation and blocks unknown blind retry", () => {
    expect(evaluateSubmissionEligibility({
      item_status: "RESERVED",
      reservation_status: "ACTIVE",
      reservation_amount_pence: 408,
      item_amount_pence: 408,
      destination_active: true,
      provider_link_verified: true,
    }).ok).toBe(true);
    expect(evaluateSubmissionEligibility({
      item_status: "VALIDATED",
      reservation_status: "ACTIVE",
      reservation_amount_pence: 408,
      item_amount_pence: 408,
    })).toMatchObject({ code: SUBMISSION_ERROR.PAYOUT_ITEM_NOT_RESERVED });
    expect(evaluateSubmissionEligibility({
      item_status: "RESERVED",
      reservation_status: "ACTIVE",
      reservation_amount_pence: 408,
      item_amount_pence: 408,
      existing_intent_status: "UNKNOWN",
    })).toMatchObject({ code: SUBMISSION_ERROR.UNKNOWN_NO_BLIND_RETRY });
  });

  it("maps pending/submitted success without debit; hard reject releases", () => {
    const pending = mapProviderSubmissionOutcome({
      http_ok: true,
      provider_payment_id: "pay-1",
      provider_state: "pending",
    });
    expect(pending).toMatchObject({
      execution_status: "SUBMITTED",
      keep_reservation_active: true,
      release_reservation: false,
      wallet_debited: false,
      paid: false,
    });
    const declined = mapProviderSubmissionOutcome({
      http_ok: false,
      hard_reject: true,
      provider_state: "declined",
    });
    expect(declined.release_reservation).toBe(true);
    expect(declined.wallet_debited).toBe(false);
    const unknown = mapProviderSubmissionOutcome({ http_ok: false, timed_out: true });
    expect(unknown.execution_status).toBe("UNKNOWN");
    expect(unknown.release_reservation).toBe(false);
  });

  it("blocks company transfers and arbitrary payments", () => {
    expect(rejectCompanyOrArbitraryPayment({ company_transfer: true })).toMatchObject({
      code: SUBMISSION_ERROR.COMPANY_TRANSFER_BLOCKED,
    });
    expect(rejectCompanyOrArbitraryPayment({ raw_pay: true })).toMatchObject({
      code: SUBMISSION_ERROR.ARBITRARY_PAYMENT_BLOCKED,
    });
    expect(rejectCompanyOrArbitraryPayment({ payout_item_id: "x" }).ok).toBe(true);
  });

  it("admin display keeps Paid=Not paid and wallet debit not applied", () => {
    const d = adminItemSubmissionDisplay({
      item_status: "SUBMITTED",
      provider_state: "pending",
      provider_payment_id: "abcdef12-3456-7890",
      reservation_active: true,
    });
    expect(d.reserved_label).toBe(ADMIN_SLICE7_LABELS.RESERVED);
    expect(d.paid_label).toBe(ADMIN_SLICE7_LABELS.NOT_PAID);
    expect(d.wallet_debit_label).toBe(ADMIN_SLICE7_LABELS.WALLET_DEBIT_NOT_APPLIED);
    expect(d.provider_payment_id_masked).toBe(maskProviderId("abcdef12-3456-7890"));
    expect(d.provider_submission_status).toBe(ADMIN_SLICE7_LABELS.PROVIDER_PENDING);
  });

  it("proof constants and money-safety invariants", () => {
    expect(SLICE7_PROOF_DRIVERS.BOSTEYO_AMOUNT_PENCE).toBe(408);
    expect(SLICE7_PROOF_DRIVERS.AHMED_AMOUNT_PENCE).toBe(1001);
    expect(() => assertSlice7MoneySafety({
      wallet_debited: false,
      reservation_consumed: false,
      paid_marked: false,
      live_payout_execution_enabled: false,
      slices_8_to_12_started: false,
    })).not.toThrow();
    expect(() => assertSlice7MoneySafety({ wallet_debited: true })).toThrow();
    expect(() => assertSlice7MoneySafety({ live_payout_execution_enabled: true })).not.toThrow();
  });
});
