/**
 * Lock: FR payout reconciliation period parity + tip credits + provider-fee ownership.
 * MK0006 false freeze: early cashout payout_items restamped updated_at into this week
 * while wallet EARLY_CASHOUT created_at stayed historical → false −4398 PAYOUT_MISMATCH.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildPeriodScopedFrDriverInputs,
  computeFrDriverReconciliation,
  sumActualWalletTripCreditsPence,
  sumCompletedPayoutLedgerPence,
  sumPayoutWalletTransfersPence,
} from "../../functions/_shared/frDriverReconciliationSSOT.ts";
import {
  resolveFrDriverExpectedEntitlement,
  resolveFrTerminalFeeExpectedEntitlementPence,
  resolveTerminalFeeDriverTenPence,
} from "../../functions/_shared/frDriverExpectedEntitlementSSOT.ts";

const WEEK_FROM = "2026-09-20T23:00:00.000Z";
const WEEK_TO = "2026-09-23T22:59:59.999Z";

Deno.test("period parity: restamped payout_item updated_at must not pull historical cashouts into this week", () => {
  const ledger = [
    {
      type: "EARLY_CASHOUT",
      amount_pence: -3269,
      created_at: "2026-09-16T21:08:57.625Z",
    },
    {
      type: "EARLY_CASHOUT",
      amount_pence: -1129,
      created_at: "2026-09-18T08:00:50.131Z",
    },
    {
      type: "WEEKLY_PAYOUT",
      amount_pence: -8166,
      created_at: "2026-09-22T16:45:09.967Z",
    },
  ];
  const items = [
    {
      status: "COMPLETED",
      net_driver_payout_pence: 3269,
      amount_pence: 3319,
      created_at: "2026-09-16T21:08:53.608Z",
      // Sync restamp — must NOT include in this-week scope
      updated_at: "2026-09-21T20:37:06.149Z",
    },
    {
      status: "COMPLETED",
      net_driver_payout_pence: 1129,
      amount_pence: 1179,
      created_at: "2026-09-18T08:00:44.326Z",
      updated_at: "2026-09-21T20:37:06.149Z",
    },
    {
      status: "COMPLETED",
      net_driver_payout_pence: 8166,
      amount_pence: 8166,
      created_at: "2026-09-22T16:45:06.117Z",
      updated_at: "2026-09-22T17:15:06.070Z",
    },
  ];

  const scoped = buildPeriodScopedFrDriverInputs({
    periodFrom: WEEK_FROM,
    periodTo: WEEK_TO,
    ledger,
    settledTrips: [],
    completedPayoutItems: items,
  });

  assertEquals(sumPayoutWalletTransfersPence(scoped.ledger), 8166);
  assertEquals(sumCompletedPayoutLedgerPence(scoped.completedPayoutItems), 8166);

  const fr = computeFrDriverReconciliation({
    ledger: scoped.ledger,
    settledTrips: [],
    completedPayoutItems: scoped.completedPayoutItems,
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    finance_cleared_pence: 0,
    provider_account_balance_pence: null,
    provider_account_balance_status: "NOT_APPLICABLE",
    payout_provider: "revolut",
    query_scope_status: "PERIOD_SCOPED",
  });
  assertEquals(fr.payout_variance_pence, 0);
  assertEquals(fr.payout_status, "PAYOUT_OK");
});

Deno.test("lifetime: weekly + early cashouts align net-to-net (fees excluded from transfer basis)", () => {
  const ledger = [
    { type: "EARLY_CASHOUT", amount_pence: -3269 },
    { type: "EARLY_CASHOUT", amount_pence: -1129 },
    { type: "WEEKLY_PAYOUT", amount_pence: -8166 },
  ];
  const items = [
    { status: "COMPLETED", net_driver_payout_pence: 3269, amount_pence: 3319 },
    { status: "COMPLETED", net_driver_payout_pence: 1129, amount_pence: 1179 },
    { status: "COMPLETED", net_driver_payout_pence: 8166, amount_pence: 8166 },
  ];
  assertEquals(sumPayoutWalletTransfersPence(ledger), 12564);
  assertEquals(sumCompletedPayoutLedgerPence(items), 12564);
  assertEquals(sumPayoutWalletTransfersPence(ledger) - sumCompletedPayoutLedgerPence(items), 0);
});

Deno.test("tip credits: TEN 425 + DRIVER_TIP_CREDIT 100 = expected 525; variance 0", () => {
  const expected = resolveFrDriverExpectedEntitlement({
    trip_status: "completed",
    financial_outcome: "COMPLETED",
    financial_model: "PLATFORM_COLLECTED",
    driver_net_pence: 425,
    tip_pence: 100,
    commission_pence: 75,
  });
  assertEquals(expected.expected_entitlement_pence, 525);

  const ledger = [
    { type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "t-tip" },
    { type: "DRIVER_TIP_CREDIT", amount_pence: 100, related_trip_id: "t-tip" },
  ];
  assertEquals(sumActualWalletTripCreditsPence(ledger), 525);
  assertEquals(sumActualWalletTripCreditsPence(ledger) - 525, 0);
});

Deno.test("period scope keeps trip-linked tip credits with the trip (not dropped)", () => {
  const settledTrips = [{
    trip_id: "t-tip",
    trip_code: "MK-260919-009",
    completed_at: "2026-09-19T08:21:32.932Z",
    period_origin: "2026-09-19T08:21:32.932Z",
    expected_entitlement_pence: 525,
    expected_stamp_status: "OK" as const,
    driver_net_pence: 425,
  }];
  const scoped = buildPeriodScopedFrDriverInputs({
    periodFrom: "2026-09-01T00:00:00.000Z",
    periodTo: "2026-09-30T23:59:59.999Z",
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "t-tip" },
      { type: "DRIVER_TIP_CREDIT", amount_pence: 100, related_trip_id: "t-tip" },
    ],
    settledTrips,
    completedPayoutItems: [],
  });
  assertEquals(sumActualWalletTripCreditsPence(scoped.ledger), 525);
});

Deno.test("provider fee ownership: FR expected 500 − 65 = 435; fee 25 not deducted", () => {
  assertEquals(
    resolveFrTerminalFeeExpectedEntitlementPence({
      captured_pence: 500,
      commission_pence: 65,
    }),
    435,
  );
  // Legacy settlement helper may still deduct fee — FR must not use it for variance.
  assertEquals(
    resolveTerminalFeeDriverTenPence({
      captured_pence: 500,
      provider_fee_pence: 25,
      commission_pence: 65,
    }),
    410,
  );
  const row = resolveFrDriverExpectedEntitlement({
    trip_status: "cancelled",
    financial_outcome: "CANCELLED_WITH_FEE",
    financial_model: "PLATFORM_COLLECTED",
    captured_amount_pence: 500,
    provider_processing_fee_pence: 25,
    commission_pence: 65,
    driver_net_pence: 435,
  });
  assertEquals(row.expected_entitlement_pence, 435);
  assertEquals(row.entitlement_source, "terminal_fee_capture_minus_commission");
});
