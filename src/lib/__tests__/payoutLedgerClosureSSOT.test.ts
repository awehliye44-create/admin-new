import { describe, expect, it } from "vitest";
import { isAllocatableWalletLedgerType, evaluatePayoutEligibilityGate } from "../../../shared/payoutAllocationEligibilitySSOT";
import { normalizePayoutItemStatus } from "../../../shared/payoutCanonicalStatusSSOT";
import { resolvePayoutTransferAmountPence } from "../../../shared/payoutLedgerConsumeDwlSSOT";

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
});
