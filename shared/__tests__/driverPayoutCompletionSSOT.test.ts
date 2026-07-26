import { describe, expect, it } from "vitest";
import {
  COMPLETION_ERROR,
  NON_FINALISING_PROVIDER_STATES,
  SLICE8_LEDGER_DEBIT_TYPE,
  SLICE8_PROOF_DRIVERS,
  assertSlice8MoneySafety,
  evaluateCompletionEligibility,
  evaluateSlice8FlagGate,
  isCanonicalProviderCompleted,
  ledgerTypeForCompletionBatchKind,
  mayFinaliseFromProviderState,
} from "../driverPayoutCompletionSSOT";
import { BALANCE_EXCLUDED_LEDGER_TYPES } from "../onecabFinanceLedger";

describe("driverPayoutCompletionSSOT", () => {
  it("only canonical completed may finalise", () => {
    expect(isCanonicalProviderCompleted("completed")).toBe(true);
    expect(isCanonicalProviderCompleted("COMPLETED")).toBe(true);
    for (const s of [
      "pending",
      "submitted",
      "processing",
      "failed",
      "cancelled",
      "unknown",
      "declined",
      "",
    ]) {
      expect(isCanonicalProviderCompleted(s)).toBe(false);
      expect(mayFinaliseFromProviderState(s).ok).toBe(false);
      expect(NON_FINALISING_PROVIDER_STATES.has(s) || s === "submitted" || s === "processing")
        .toBe(true);
    }
    expect(mayFinaliseFromProviderState("completed")).toEqual({ ok: true });
  });

  it("WEEKLY_PAYOUT debit type is not balance-excluded", () => {
    expect(BALANCE_EXCLUDED_LEDGER_TYPES).not.toContain(SLICE8_LEDGER_DEBIT_TYPE);
    expect(BALANCE_EXCLUDED_LEDGER_TYPES).toContain("PAYOUT_RESERVATION_HOLD");
    expect(ledgerTypeForCompletionBatchKind("WEEKLY_SCHEDULED")).toBe("WEEKLY_PAYOUT");
    expect(ledgerTypeForCompletionBatchKind("WEEKLY_MONDAY")).toBe("WEEKLY_PAYOUT");
  });

  it("LIVE no longer blocks Slice 8 finalize (orchestrator owns LIVE gate)", () => {
    expect(
      evaluateSlice8FlagGate({
        get: (k) => (k === "LIVE_PAYOUT_EXECUTION_ENABLED" ? "true" : undefined),
      }),
    ).toEqual({ ok: true });
    expect(
      evaluateSlice8FlagGate({
        get: (k) => (k === "LIVE_PAYOUT_EXECUTION_ENABLED" ? "false" : undefined),
      }),
    ).toEqual({ ok: true });
  });

  it("eligibility accepts SUBMITTED+ACTIVE with matching ids/amounts", () => {
    const ok = evaluateCompletionEligibility({
      item_status: "SUBMITTED",
      intent_status: "SUBMITTED",
      reservation_status: "ACTIVE",
      item_amount_pence: SLICE8_PROOF_DRIVERS.BOSTEYO_AMOUNT_PENCE,
      reservation_amount_pence: SLICE8_PROOF_DRIVERS.BOSTEYO_AMOUNT_PENCE,
      intent_amount_pence: SLICE8_PROOF_DRIVERS.BOSTEYO_AMOUNT_PENCE,
      currency: "GBP",
      driver_id: SLICE8_PROOF_DRIVERS.BOSTEYO_ID,
      reservation_driver_id: SLICE8_PROOF_DRIVERS.BOSTEYO_ID,
      intent_driver_id: SLICE8_PROOF_DRIVERS.BOSTEYO_ID,
      intent_provider_payment_id: "054bfe51-9ec1-e34d-0040-62fd28cbd015",
    });
    expect(ok).toEqual({ ok: true });
  });

  it("rejects amount mismatch and missing payment id", () => {
    const amt = evaluateCompletionEligibility({
      item_status: "SUBMITTED",
      intent_status: "SUBMITTED",
      reservation_status: "ACTIVE",
      item_amount_pence: 408,
      reservation_amount_pence: 1001,
      intent_amount_pence: 408,
      currency: "GBP",
      driver_id: SLICE8_PROOF_DRIVERS.BOSTEYO_ID,
      intent_provider_payment_id: "pay-1",
    });
    expect(amt.ok).toBe(false);
    if (!amt.ok) expect(amt.code).toBe(COMPLETION_ERROR.AMOUNT_MISMATCH);

    const missing = evaluateCompletionEligibility({
      item_status: "SUBMITTED",
      intent_status: "SUBMITTED",
      reservation_status: "ACTIVE",
      item_amount_pence: 408,
      reservation_amount_pence: 408,
      intent_amount_pence: 408,
      currency: "GBP",
      driver_id: SLICE8_PROOF_DRIVERS.BOSTEYO_ID,
      intent_provider_payment_id: null,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe(COMPLETION_ERROR.MISSING_PROVIDER_PAYMENT_ID);
  });

  it("money safety: debit/consume only with completed; together; no /pay", () => {
    expect(() =>
      assertSlice8MoneySafety({
        provider_state: "completed",
        wallet_debited: true,
        reservation_consumed: true,
        live_payout_execution_enabled: false,
        revolut_pay_called: false,
      }),
    ).not.toThrow();

    expect(() =>
      assertSlice8MoneySafety({
        provider_state: "pending",
        wallet_debited: true,
        reservation_consumed: true,
      }),
    ).toThrow(/canonical Revolut completed/);

    expect(() =>
      assertSlice8MoneySafety({
        provider_state: "completed",
        wallet_debited: true,
        reservation_consumed: false,
      }),
    ).toThrow(/together/);

    expect(() =>
      assertSlice8MoneySafety({
        provider_state: "completed",
        wallet_debited: true,
        reservation_consumed: true,
        revolut_pay_called: true,
      }),
    ).toThrow(/must not create another Revolut/);
  });
});
