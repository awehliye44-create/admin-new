import { describe, expect, it } from "vitest";
import { isAllocatableWalletLedgerType, evaluatePayoutEligibilityGate } from "../../../shared/payoutAllocationEligibilitySSOT";
import { normalizePayoutItemStatus } from "../../../shared/payoutCanonicalStatusSSOT";
import { resolvePayoutTransferAmountPence } from "../../../shared/payoutLedgerConsumeDwlSSOT";
import {
  planEligibleLedgerAllocations,
  payoutDestinationLabel,
} from "../../../shared/payoutLedgerHandoffSSOT";
import { shouldBlockZeroValuePayoutBatch } from "../../../shared/driverPayoutEligibilitySSOT";

describe("payout ledger closure SSOT", () => {
  it("resolvePayoutTransferAmountPence never exceeds available balance", () => {
    expect(resolvePayoutTransferAmountPence({
      available_balance_pence: 1_000,
      requested_pence: 1_500,
    })).toBe(1_000);
  });

  it("isAllocatableWalletLedgerType rejects commission and provider fee rows", () => {
    expect(isAllocatableWalletLedgerType("PLATFORM_COMMISSION")).toBe(false);
    expect(isAllocatableWalletLedgerType("PAYMENT_PROVIDER_FEE")).toBe(false);
    expect(isAllocatableWalletLedgerType("TRIP_EARNING_NET")).toBe(true);
  });

  it("normalizes legacy payout item statuses", () => {
    expect(normalizePayoutItemStatus("pending")).toBe("PENDING");
    expect(normalizePayoutItemStatus("completed")).toBe("PAID");
  });

  it("evaluatePayoutEligibilityGate fails when amount exceeds available", () => {
    const result = evaluatePayoutEligibilityGate({
      amount_pence: 2_000,
      available_balance_pence: 1_000,
      connected_account: true,
      currency: "GBP",
      idempotency_key: "weekly:sa:2026-07-11:driver",
    });

    expect(result.ok).toBe(false);
    expect(result.hold_status).toBe("ELIGIBILITY_HOLD");
    expect(result.reasons).toContain("AMOUNT_EXCEEDS_AVAILABLE_BALANCE");
  });

  it("evaluatePayoutEligibilityGate accepts Revolut/manual destination without Connect", () => {
    const result = evaluatePayoutEligibilityGate({
      amount_pence: 408,
      available_balance_pence: 408,
      connected_account: true,
      payout_destination_ready: true,
      currency: "GBP",
      idempotency_key: "weekly:global:2026-07-12:ahmed",
    });
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("evaluatePayoutEligibilityGate blocks missing payout destination", () => {
    const result = evaluatePayoutEligibilityGate({
      amount_pence: 100,
      available_balance_pence: 100,
      connected_account: false,
      currency: "GBP",
      idempotency_key: "weekly:global:2026-07-12:x",
    });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("PAYOUT_DESTINATION_REQUIRED");
  });

  it("planEligibleLedgerAllocations is FIFO and exact", () => {
    const lines = planEligibleLedgerAllocations({
      eligible_entries: [
        { ledger_entry_id: "a", amount_pence: 408 },
        { ledger_entry_id: "b", amount_pence: 593 },
      ],
      amount_pence: 500,
    });
    expect(lines).toEqual([
      { ledger_entry_id: "a", amount_pence: 408 },
      { ledger_entry_id: "b", amount_pence: 92 },
    ]);
  });

  it("planEligibleLedgerAllocations never double-pays a ledger entry", () => {
    const lines = planEligibleLedgerAllocations({
      eligible_entries: [
        { ledger_entry_id: "a", amount_pence: 408 },
        { ledger_entry_id: "b", amount_pence: 200 },
      ],
      already_allocated_by_ledger: { a: 408 },
      amount_pence: 200,
    });
    expect(lines).toEqual([{ ledger_entry_id: "b", amount_pence: 200 }]);
  });

  it("planEligibleLedgerAllocations throws when eligible credits cannot cover amount", () => {
    expect(() => planEligibleLedgerAllocations({
      eligible_entries: [{ ledger_entry_id: "a", amount_pence: 100 }],
      amount_pence: 200,
    })).toThrow(/does not equal payout amount/);
  });

  it("shouldBlockZeroValuePayoutBatch returns NO_ELIGIBLE_PAYOUTS", () => {
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

  it("payoutDestinationLabel prefers manual bank wording for Revolut", () => {
    expect(payoutDestinationLabel({ provider: "revolut", manual_bank: true })).toBe("Manual bank");
  });
});
