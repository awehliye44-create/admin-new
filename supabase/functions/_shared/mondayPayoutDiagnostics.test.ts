import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  aggregateMondayPayoutTodayCards,
  deriveSettlementStatus,
  formatProviderFailureReason,
  grossMinusCommissionBalanced,
  netPayoutAllocationBalanced,
  reconcileMondayPayoutRow,
} from "./mondayPayoutDiagnostics.ts";

Deno.test("formatProviderFailureReason uses fallback when empty", () => {
  assertEquals(
    formatProviderFailureReason(""),
    "Provider did not return a failure reason. Check payout provider logs.",
  );
  assertEquals(formatProviderFailureReason("insufficient_funds"), "insufficient_funds");
});

Deno.test("deriveSettlementStatus PARTIAL_SETTLEMENT when commission recovered and payout failed", () => {
  assertEquals(
    deriveSettlementStatus({
      payoutStatus: "failed",
      cashCommissionRecoveredPence: 1338,
      driverPaidOutPence: 0,
      failedPayoutAmountPence: 5000,
      returnedToWalletPence: 5000,
    }),
    "PARTIAL_SETTLEMENT",
  );
});

Deno.test("gross minus commission equals net", () => {
  assertEquals(grossMinusCommissionBalanced(11338, 1338, 10000), true);
  assertEquals(grossMinusCommissionBalanced(11338, 1338, 9998), false);
});

Deno.test("net allocation reconciliation", () => {
  assertEquals(
    netPayoutAllocationBalanced(10000, 0, 10000, 0, 0),
    true,
  );
  assertEquals(
    netPayoutAllocationBalanced(10000, 0, 0, 0, 10000),
    true,
  );
  assertEquals(
    reconcileMondayPayoutRow({
      gross_payable_pence: 11338,
      cash_commission_recovered_pence: 1338,
      net_driver_payout_pence: 10000,
      driver_paid_out_pence: 0,
      failed_payout_amount_pence: 10000,
      driver_pending_pence: 0,
      returned_to_wallet_pence: 10000,
      payout_status: "failed",
    }).status,
    "BALANCED",
  );
});

Deno.test("aggregateMondayPayoutTodayCards sums rows", () => {
  const cards = aggregateMondayPayoutTodayCards([
    {
      payout_item_id: "1",
      batch_id: "b",
      batch_kind: "WEEKLY_MONDAY",
      driver_id: "d",
      driver_name: "Test",
      gross_payable_pence: 11338,
      cash_commission_recovered_pence: 1338,
      net_driver_payout_pence: 10000,
      payout_status: "failed",
      settlement_status: "PARTIAL_SETTLEMENT",
      driver_paid_out_pence: 0,
      failed_payout_amount_pence: 10000,
      driver_pending_pence: 0,
      returned_to_wallet_pence: 10000,
      provider_status: "failed",
      provider_reference: "tr_123",
      failure_reason: "account_closed",
      failed_at: "2026-06-09T10:00:00Z",
      reconciliation_status: "BALANCED",
      reconciliation_detail: null,
      created_at: "",
      completed_at: null,
    },
  ]);
  assertEquals(cards.onecab_commission_recovered_pence, 1338);
  assertEquals(cards.driver_payout_failed_pence, 10000);
  assertEquals(cards.returned_to_wallet_pence, 10000);
});
