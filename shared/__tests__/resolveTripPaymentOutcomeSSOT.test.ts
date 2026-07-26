import { describe, expect, it } from "vitest";
import {
  TRIP_PAYMENT_OUTCOME,
  resolveCanonicalCustomerPayablePence,
  resolveTripPaymentOutcome,
} from "../resolveTripPaymentOutcomeSSOT";

describe("resolveCanonicalCustomerPayablePence", () => {
  it("cancel uses fee only — ignores booking final fare", () => {
    expect(
      resolveCanonicalCustomerPayablePence({
        trip_status: "customer_cancelled",
        final_fare_pence: 1378,
        cancellation_fee_pence: 0,
      }),
    ).toBe(0);
    expect(
      resolveCanonicalCustomerPayablePence({
        trip_status: "customer_cancelled",
        final_fare_pence: 480,
        cancellation_fee_pence: 250,
      }),
    ).toBe(250);
  });

  it("completed uses canonical payable", () => {
    expect(
      resolveCanonicalCustomerPayablePence({
        trip_status: "completed",
        canonical_payable_pence: 840,
        final_fare_pence: 875,
      }),
    ).toBe(840);
  });
});

describe("resolveTripPaymentOutcome", () => {
  it("MK-008 style: completed auth>fare → CAPTURE_AND_RELEASE_REMAINDER", () => {
    const r = resolveTripPaymentOutcome({
      trip_status: "completed",
      canonical_payable_pence: 840,
      total_authorised_pence: 1140,
      total_captured_pence: 0,
      provider_state: "AUTHORISED",
      payment_status: "capture_failed",
      payment_hold_status: "authorised_hold",
    });
    expect(r.outcome).toBe(TRIP_PAYMENT_OUTCOME.CAPTURE_AND_RELEASE_REMAINDER);
    expect(r.capture_amount_pence).toBe(840);
    expect(r.release_amount_pence).toBe(300);
    expect(r.provider_mutation_allowed).toBe(true);
  });

  it("MK-001 style: cancel fee 0 AUTHORISED → RELEASE_FULL_HOLD", () => {
    const r = resolveTripPaymentOutcome({
      trip_status: "customer_cancelled",
      final_fare_pence: 1378,
      cancellation_fee_pence: 0,
      total_authorised_pence: 1678,
      total_captured_pence: 0,
      provider_state: "AUTHORISED",
      payment_status: "authorized",
      payment_hold_status: "authorised_hold",
    });
    expect(r.outcome).toBe(TRIP_PAYMENT_OUTCOME.RELEASE_FULL_HOLD);
    expect(r.canonical_payable_pence).toBe(0);
    expect(r.release_amount_pence).toBe(1678);
    expect(r.provider_mutation_allowed).toBe(true);
  });

  it("MK-005 style: provider CANCELLED → NO_ACTION local reconcile", () => {
    const r = resolveTripPaymentOutcome({
      trip_status: "customer_cancelled",
      final_fare_pence: 480,
      cancellation_fee_pence: 0,
      total_authorised_pence: 780,
      total_captured_pence: 0,
      provider_state: "CANCELLED",
      payment_status: "canceled",
      payment_hold_status: "authorised_hold",
    });
    expect(r.outcome).toBe(TRIP_PAYMENT_OUTCOME.NO_ACTION_ALREADY_RESOLVED);
    expect(r.local_reconcile_only).toBe(true);
    expect(r.provider_mutation_allowed).toBe(false);
  });

  it("shortfall → ADDITIONAL_AUTHORISATION_REQUIRED", () => {
    const r = resolveTripPaymentOutcome({
      trip_status: "completed",
      canonical_payable_pence: 1300,
      total_authorised_pence: 1000,
      total_captured_pence: 0,
      provider_state: "AUTHORISED",
    });
    expect(r.outcome).toBe(TRIP_PAYMENT_OUTCOME.ADDITIONAL_AUTHORISATION_REQUIRED);
    expect(r.shortfall_pence).toBe(300);
  });

  it("already captured matching payable → NO_ACTION (not local cancel reconcile)", () => {
    const r = resolveTripPaymentOutcome({
      trip_status: "completed",
      canonical_payable_pence: 840,
      total_authorised_pence: 1140,
      total_captured_pence: 840,
      provider_state: "COMPLETED",
    });
    expect(r.outcome).toBe(TRIP_PAYMENT_OUTCOME.NO_ACTION_ALREADY_RESOLVED);
    expect(r.local_reconcile_only).toBe(false);
  });
});
