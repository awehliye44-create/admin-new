import { describe, expect, it } from "vitest";
import {
  PAYOUT_ELIGIBILITY_STATUS,
  aggregateDriverPayoutEligibility,
  desCompanionIdempotencyKey,
  deriveTripFrStatusForPayoutEligibility,
  evaluateLedgerEntryEligibility,
  shouldBlockZeroValuePayoutBatch,
  type LedgerEligibilityEvidence,
} from "../../../shared/driverPayoutEligibilitySSOT";

function revolutTripCredit(overrides: Partial<LedgerEligibilityEvidence> = {}): LedgerEligibilityEvidence {
  return {
    ledger_entry_id: "8f327a10-6517-4c36-82ef-124862a5cb56",
    trip_id: "trip-mk-007",
    ledger_type: "TRIP_EARNING_NET",
    amount_pence: 408,
    trip_exists: true,
    payment_session_id: "977de67e-ps",
    captured_amount_pence: 480,
    canonical_driver_net_pence: 408,
    fr_trip_status: "BALANCED",
    refunded_amount_pence: 0,
    des_present: false,
    ...overrides,
  };
}

describe("driverPayoutEligibilitySSOT — Revolut trip credits", () => {
  it("1. Valid Revolut TRIP_EARNING_NET with captured PS becomes eligible", () => {
    const r = evaluateLedgerEntryEligibility(revolutTripCredit());
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE);
    expect(r.payable_pence).toBe(408);
  });

  it("2. Missing DES does not force available to zero when evidence is complete", () => {
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 1001,
      outstanding_debt_pence: 0,
      entries: [
        revolutTripCredit({ amount_pence: 408, canonical_driver_net_pence: 408, des_present: false }),
        revolutTripCredit({
          ledger_entry_id: "35ee604f-5ec1-4ed0-b15d-cd1780fe7be6",
          trip_id: "trip-mk-008",
          amount_pence: 593,
          captured_amount_pence: 698,
          canonical_driver_net_pence: 593,
          payment_session_id: "a2705aae-ps",
          des_present: false,
        }),
      ],
    });
    expect(agg.available_balance_pence).toBe(1001);
    expect(agg.pending_balance_pence).toBe(0);
    expect(agg.eligible_entries).toHaveLength(2);
    expect(agg.eligible_entries.every((e) => e.des_companion_missing)).toBe(true);
  });

  it("3. Missing DES is flagged for repair but entry stays eligible", () => {
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 408,
      entries: [revolutTripCredit({ des_present: false })],
    });
    expect(agg.eligible_entries[0]?.des_companion_missing).toBe(true);
    expect(agg.available_balance_pence).toBe(408);
  });

  it("4. Stripe fields are not required", () => {
    const r = evaluateLedgerEntryEligibility(
      revolutTripCredit({
        // No stripe_* fields exist on the evidence type by design.
        des_present: false,
      }),
    );
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE);
  });

  it("5. Ahmed becomes available £10.01", () => {
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 1001,
      entries: [
        revolutTripCredit({ amount_pence: 408, canonical_driver_net_pence: 408 }),
        revolutTripCredit({
          ledger_entry_id: "35ee604f",
          trip_id: "t2",
          amount_pence: 593,
          captured_amount_pence: 698,
          canonical_driver_net_pence: 593,
          payment_session_id: "ps2",
        }),
      ],
    });
    expect(agg.live_balance_pence).toBe(1001);
    expect(agg.available_balance_pence).toBe(1001);
    expect(agg.pending_balance_pence).toBe(0);
  });

  it("6. Bosteyo becomes available £4.08", () => {
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 408,
      entries: [
        revolutTripCredit({
          ledger_entry_id: "eb8bb314-2a8c-4bee-9707-9e1758177d9e",
          trip_id: "trip-mk-010",
          amount_pence: 408,
          captured_amount_pence: 480,
          canonical_driver_net_pence: 408,
          payment_session_id: "1e0d1ff4-ps",
        }),
      ],
    });
    expect(agg.available_balance_pence).toBe(408);
  });

  it("7. Fleet available becomes £14.09", () => {
    const ahmed = aggregateDriverPayoutEligibility({
      live_balance_pence: 1001,
      entries: [
        revolutTripCredit({ amount_pence: 408, canonical_driver_net_pence: 408 }),
        revolutTripCredit({
          ledger_entry_id: "b",
          trip_id: "t2",
          amount_pence: 593,
          captured_amount_pence: 698,
          canonical_driver_net_pence: 593,
          payment_session_id: "ps2",
        }),
      ],
    });
    const bosteyo = aggregateDriverPayoutEligibility({
      live_balance_pence: 408,
      entries: [revolutTripCredit({ ledger_entry_id: "c", trip_id: "t3", payment_session_id: "ps3" })],
    });
    expect(ahmed.available_balance_pence + bosteyo.available_balance_pence).toBe(1409);
  });

  it("8. Wallet credit mismatch remains held", () => {
    const r = evaluateLedgerEntryEligibility(
      revolutTripCredit({ amount_pence: 500, canonical_driver_net_pence: 408 }),
    );
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.WALLET_CREDIT_MISMATCH);
  });

  it("9. Capture mismatch remains held", () => {
    const r = evaluateLedgerEntryEligibility(
      revolutTripCredit({ captured_amount_pence: 100, canonical_driver_net_pence: 408 }),
    );
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.CAPTURE_MISMATCH);
  });

  it("10. Refunded entry remains held", () => {
    const r = evaluateLedgerEntryEligibility(
      revolutTripCredit({ refunded_amount_pence: 480 }),
    );
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.REFUND_HOLD);
  });

  it("11. Already allocated entry cannot be allocated again", () => {
    const r = evaluateLedgerEntryEligibility(
      revolutTripCredit({ allocated_to_payout: true }),
    );
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.PAYOUT_ALLOCATED);
    expect(r.payable_pence).toBe(0);
  });

  it("12. Same eligibility function powers DWL and PL aggregates", () => {
    const entries = [revolutTripCredit()];
    const dwl = aggregateDriverPayoutEligibility({ live_balance_pence: 408, entries });
    const pl = aggregateDriverPayoutEligibility({ live_balance_pence: 408, entries });
    expect(dwl).toEqual(pl);
  });

  it("13. Aggregate exposes balances — no React financial sums needed", () => {
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 1001,
      outstanding_debt_pence: 0,
      entries: [
        revolutTripCredit({ amount_pence: 408, canonical_driver_net_pence: 408 }),
        revolutTripCredit({
          ledger_entry_id: "b",
          trip_id: "t2",
          amount_pence: 593,
          captured_amount_pence: 698,
          canonical_driver_net_pence: 593,
          payment_session_id: "ps2",
        }),
      ],
    });
    expect(agg).toMatchObject({
      live_balance_pence: 1001,
      available_balance_pence: 1001,
      pending_balance_pence: 0,
      outstanding_debt_pence: 0,
    });
  });

  it("14. Zero-value payout batch is never created", () => {
    expect(shouldBlockZeroValuePayoutBatch({
      eligible_driver_count: 0,
      total_available_pence: 1409,
    })).toEqual({ block: true, error_code: "NO_ELIGIBLE_PAYOUTS" });
    expect(shouldBlockZeroValuePayoutBatch({
      eligible_driver_count: 2,
      total_available_pence: 0,
    })).toEqual({ block: true, error_code: "NO_ELIGIBLE_PAYOUTS" });
    expect(shouldBlockZeroValuePayoutBatch({
      eligible_driver_count: 2,
      total_available_pence: 1409,
    })).toEqual({ block: false, error_code: null });
  });

  it("15. Backfill idempotency key is stable", () => {
    const a = desCompanionIdempotencyKey("8f327a10", "REVOLUT_PHASE1_BACKFILL");
    const b = desCompanionIdempotencyKey("8f327a10", "REVOLUT_PHASE1_BACKFILL");
    expect(a).toBe(b);
    expect(a).toBe("des:REVOLUT_PHASE1_BACKFILL:8f327a10");
  });

  it("missing capture is CAPTURE_PENDING — never RECONCILIATION_PENDING; DES absence does not invent a separate hold", () => {
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 408,
      entries: [
        revolutTripCredit({
          payment_session_id: null,
          captured_amount_pence: null,
          des_present: false,
        }),
      ],
    });
    expect(agg.primary_hold_reason).toBe(PAYOUT_ELIGIBILITY_STATUS.CAPTURE_PENDING);
    expect(String(agg.primary_hold_reason)).not.toBe("RECONCILIATION_PENDING");
    expect(String(agg.primary_hold_reason)).not.toBe("MISSING_EARNING_SETTLEMENT");
  });

  it("eligible with complete PS + settlement even when DES companion missing", () => {
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 408,
      entries: [
        revolutTripCredit({
          des_present: false,
        }),
      ],
    });
    expect(agg.available_balance_pence).toBe(408);
    expect(agg.pending_balance_pence).toBe(0);
    expect(agg.eligible_entries[0]?.des_companion_missing).toBe(true);
  });

  it("DWL/PL pending parity: pending = live − available", () => {
    const eligible = aggregateDriverPayoutEligibility({
      live_balance_pence: 1409,
      entries: [
        revolutTripCredit({ amount_pence: 408, ledger_entry_id: "a", trip_id: "t1" }),
        revolutTripCredit({
          amount_pence: 593,
          ledger_entry_id: "b",
          trip_id: "t2",
          captured_amount_pence: 698,
          canonical_driver_net_pence: 593,
        }),
        revolutTripCredit({ amount_pence: 408, ledger_entry_id: "c", trip_id: "t3" }),
      ],
    });
    expect(eligible.available_balance_pence).toBe(1409);
    expect(eligible.pending_balance_pence).toBe(0);
    expect(eligible.pending_balance_pence).toBe(
      Math.max(0, eligible.live_balance_pence - eligible.available_balance_pence),
    );

    const held = aggregateDriverPayoutEligibility({
      live_balance_pence: 408,
      entries: [
        revolutTripCredit({
          payment_session_id: null,
          captured_amount_pence: null,
        }),
      ],
    });
    expect(held.available_balance_pence).toBe(0);
    expect(held.pending_balance_pence).toBe(408);
  });

  it("FR/settlement completeness derives BALANCED without Stripe", () => {
    expect(deriveTripFrStatusForPayoutEligibility({
      canonical_driver_net_pence: 408,
      captured_amount_pence: 480,
      settlement_formula_version: "2",
      completed_at: "2026-07-08T12:00:00Z",
      trip_payment_status: "captured",
    })).toBe("BALANCED");

    const r = evaluateLedgerEntryEligibility(
      revolutTripCredit({ fr_trip_status: "BALANCED" }),
    );
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE);
  });

  it("admin hold blocks available", () => {
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 408,
      payouts_enabled: false,
      entries: [revolutTripCredit()],
    });
    expect(agg.available_balance_pence).toBe(0);
    expect(agg.primary_hold_reason).toBe(PAYOUT_ELIGIBILITY_STATUS.ADMIN_HOLD);
  });
});
