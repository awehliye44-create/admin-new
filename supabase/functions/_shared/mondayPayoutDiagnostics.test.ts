import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  aggregateMondayPayoutTodayCards,
  buildMondayPayoutDiagnosticsRow,
  deriveSettlementStatus,
  filterMondayPayoutRowsForLondonToday,
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

Deno.test("deriveSettlementStatus FAILED for FAILED_DUPLICATE", () => {
  assertEquals(
    deriveSettlementStatus({
      payoutStatus: "FAILED_DUPLICATE",
      cashCommissionRecoveredPence: 0,
      driverPaidOutPence: 0,
      failedPayoutAmountPence: 0,
      returnedToWalletPence: 0,
    }),
    "FAILED",
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
      driver_wallet_balance_pence: null,
      driver_debt_pence: null,
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
      payout_policy_violation: false,
      payout_policy_violation_detail: null,
      created_at: "",
      completed_at: null,
    },
  ]);
  assertEquals(cards.onecab_commission_recovered_pence, 1338);
  assertEquals(cards.driver_payout_failed_pence, 10000);
  assertEquals(cards.returned_to_wallet_pence, 10000);
});

Deno.test("filterMondayPayoutRowsForLondonToday excludes historical completed payouts", () => {
  const todayStart = "2026-06-22T00:00:00.000Z";
  const rows = [
    {
      payout_item_id: "old",
      completed_at: "2026-06-20T12:00:00Z",
      created_at: "2026-06-20T11:00:00Z",
      failed_at: null,
      payout_status: "completed",
      driver_paid_out_pence: 278,
      cash_commission_recovered_pence: 0,
      failed_payout_amount_pence: 0,
      driver_pending_pence: 0,
      returned_to_wallet_pence: 0,
    },
    {
      payout_item_id: "today",
      completed_at: "2026-06-22T14:00:00Z",
      created_at: "2026-06-22T13:00:00Z",
      failed_at: null,
      payout_status: "completed",
      driver_paid_out_pence: 500,
      cash_commission_recovered_pence: 0,
      failed_payout_amount_pence: 0,
      driver_pending_pence: 0,
      returned_to_wallet_pence: 0,
      driver_wallet_balance_pence: null,
      driver_debt_pence: null,
      payout_policy_violation: false,
      payout_policy_violation_detail: null,
    },
  ] as Parameters<typeof filterMondayPayoutRowsForLondonToday>[0];

  const todayRows = filterMondayPayoutRowsForLondonToday(rows, todayStart);
  assertEquals(todayRows.length, 1);
  assertEquals(todayRows[0].payout_item_id, "today");
  const cards = aggregateMondayPayoutTodayCards(todayRows);
  assertEquals(cards.driver_payout_sent_pence, 500);
});

Deno.test("local failed payout without Stripe evidence is FAILED not PROCESSING", () => {
  assertEquals(
    deriveSettlementStatus({
      payoutStatus: "failed",
      cashCommissionRecoveredPence: 0,
      driverPaidOutPence: 0,
      failedPayoutAmountPence: 973,
      returnedToWalletPence: 0,
    }),
    "FAILED",
  );
});

Deno.test("local failed £9.73 reconciles as balanced when not Stripe paid", () => {
  assertEquals(
    reconcileMondayPayoutRow({
      gross_payable_pence: 973,
      cash_commission_recovered_pence: 0,
      net_driver_payout_pence: 973,
      driver_paid_out_pence: 0,
      failed_payout_amount_pence: 973,
      driver_pending_pence: 0,
      returned_to_wallet_pence: 0,
      payout_status: "failed",
      payout_evidence_type: "local_only",
    }).status,
    "BALANCED",
  );
});

Deno.test("buildMondayPayoutDiagnosticsRow labels local failed without Stripe ids", () => {
  const row = buildMondayPayoutDiagnosticsRow({
    item: {
      id: "bee55265",
      driver_id: "d1",
      status: "failed",
      amount_pence: 973,
      settlement_status: "PROCESSING",
      failure_reason: "insufficient funds",
      created_at: "2026-06-27T14:01:03Z",
    },
    batchKind: "MANUAL_ADMIN",
    driverName: "Ahmed",
    driverWalletBalancePence: 973,
    platformAvailablePence: 45,
  });
  assertEquals(row.settlement_status, "FAILED");
  assertEquals(row.failed_payout_amount_pence, 973);
  assertEquals(row.payout_evidence_type, "local_only");
  assertEquals(row.retry_blocked_reason?.includes("insufficient"), true);
});

Deno.test("buildMondayPayoutDiagnosticsRow flags debt driver with completed payout", () => {
  const row = buildMondayPayoutDiagnosticsRow({
    item: {
      id: "pi1",
      driver_id: "d1",
      status: "completed",
      amount_pence: 278,
      net_driver_payout_pence: 278,
      driver_paid_out_pence: 278,
      gross_payable_pence: 278,
      created_at: "2026-06-22T08:00:00Z",
      completed_at: "2026-06-22T08:05:00Z",
    },
    batchKind: "MANUAL_ADMIN",
    driverName: "Ahmed Osman",
    driverWalletBalancePence: -278,
  });
  assertEquals(row.payout_policy_violation, true);
  assertEquals(row.driver_debt_pence, 278);
});
