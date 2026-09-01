import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildFrDriverSettlementTripRow,
  FR_EXPECTED_STAMP_STATUS,
  isTerminalFeeFinancialOutcome,
  resolveFrDriverExpectedEntitlement,
  resolveTerminalFeeDriverTenPence,
  resolveFrTripFinancialSettledAt,
  sumFrDriverExpectedEntitlementPence,
} from "./frDriverExpectedEntitlementSSOT.ts";
import {
  classifyFrDriverCreditStatus,
  computeFrDriverReconciliation,
  isInstantInFinancePeriod,
  sumActualWalletTripCreditsPence,
} from "./frDriverReconciliationSSOT.ts";

Deno.test("1. no-show 400p capture + 24p provider fee + 376p TEN => OK", () => {
  const row = resolveFrDriverExpectedEntitlement({
    trip_status: "no_show",
    financial_outcome: "NO_SHOW",
    financial_model: "PLATFORM_COLLECTED",
    captured_amount_pence: 400,
    provider_processing_fee_pence: 24,
    commission_pence: 0,
    driver_net_pence: 400,
  });
  assertEquals(row.expected_entitlement_pence, 376);
  assertEquals(row.expected_stamp_status, FR_EXPECTED_STAMP_STATUS.OK);
  assertEquals(
    classifyDriverCreditPair({ expected: 376, actual: 376 }),
    "DRIVER_CREDIT_OK",
  );
});

Deno.test("2. terminal outcome with completed_at NULL stays in financial period via captured_at", () => {
  const earnedAt = resolveFrTripFinancialSettledAt({
    completed_at: null,
    captured_at: "2026-08-25T10:43:49.703Z",
  });
  assertEquals(earnedAt, "2026-08-25T10:43:49.703Z");
  assertEquals(
    isInstantInFinancePeriod(
      earnedAt,
      "2026-08-24T23:00:00.000Z",
      "2026-09-01T22:59:59.999Z",
    ),
    true,
  );
  assertEquals(isTerminalFeeFinancialOutcome({
    financial_outcome: "CANCELLED_WITH_FEE",
    trip_status: "cancelled",
  }), true);
});

Deno.test("3. NULL expected stamp => EXPECTED_STAMP_MISSING, not over-credit", () => {
  const row = resolveFrDriverExpectedEntitlement({
    trip_status: "completed",
    financial_model: "PLATFORM_COLLECTED",
    driver_net_pence: null,
    captured_amount_pence: 716,
    commission_pence: null,
  });
  assertEquals(row.expected_stamp_status, FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING);
  assertEquals(row.expected_entitlement_pence, null);
  const status = classifyFrDriverCreditStatus({
    wallet_variance_pence: 609,
    expected_payable_pence: 0,
    missing_stamp_trip_count: 1,
    evaluable_trip_count: 0,
  });
  assertEquals(status, "EXPECTED_STAMP_MISSING");
});

Deno.test("4. modified trip uses modification_stamp_incomplete until settlement amount exists", () => {
  const row = resolveFrDriverExpectedEntitlement({
    trip_status: "completed",
    financial_model: "PLATFORM_COLLECTED",
    driver_net_pence: 651,
    customer_modification_charge_pence: 266,
    captured_amount_pence: 982,
    commission_pence: 115,
  });
  assertEquals(row.expected_stamp_status, FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING);
});

Deno.test("5. CASHOUT_FEE does not create payout mismatch", () => {
  const fr = computeFrDriverReconciliation({
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 1000 },
      { type: "EARLY_CASHOUT", amount_pence: -500 },
      { type: "CASHOUT_FEE", amount_pence: -50 },
    ],
    settledTrips: [{
      trip_id: "t1",
      driver_net_pence: 1000,
      expected_entitlement_pence: 1000,
      expected_stamp_status: FR_EXPECTED_STAMP_STATUS.OK,
    }],
    completedPayoutItems: [{ status: "COMPLETED", net_driver_payout_pence: 500 }],
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    finance_cleared_pence: 450,
    provider_account_balance_pence: null,
    provider_account_balance_status: "NOT_APPLICABLE",
    payout_provider: "revolut",
  });
  assertEquals(fr.payout_status, "PAYOUT_OK");
});

Deno.test("6. period expected and wallet credit use same evaluable trip population", () => {
  const trips = [
    {
      trip_id: "ok",
      driver_net_pence: 400,
      expected_entitlement_pence: 376,
      expected_stamp_status: FR_EXPECTED_STAMP_STATUS.OK,
    },
    {
      trip_id: "missing",
      driver_net_pence: null,
      expected_entitlement_pence: null,
      expected_stamp_status: FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING,
    },
  ];
  const ledger = [
    { type: "TRIP_EARNING_NET", amount_pence: 376, related_trip_id: "ok" },
    { type: "TRIP_EARNING_NET", amount_pence: 609, related_trip_id: "missing" },
  ];
  const expected = sumFrDriverExpectedEntitlementPence(trips);
  assertEquals(expected.missing_stamp_trip_count, 1);
  const evaluableIds = new Set(["ok"]);
  assertEquals(sumActualWalletTripCreditsPence(ledger, evaluableIds), 376);
  assertEquals(sumFrDriverExpectedEntitlementPence(trips.filter((t) => t.trip_id === "ok")).expected_payable_pence, 376);
});

Deno.test("7. correction posting date does not move earned period silently", () => {
  const earned = resolveFrTripFinancialSettledAt({
    captured_at: "2026-08-24T19:07:50.468Z",
    settlement_settled_at: "2026-08-30T12:00:00.000Z",
  });
  assertEquals(earned, "2026-08-24T19:07:50.468Z");
});

Deno.test("8. PLATFORM_COLLECTED only — CW trips excluded from entitlement", () => {
  const row = resolveFrDriverExpectedEntitlement({
    financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
    driver_net_pence: 500,
    captured_amount_pence: 600,
  });
  assertEquals(row.expected_stamp_status, FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING);
  assertEquals(row.entitlement_source, "commission_wallet_not_applicable");
});

Deno.test("MK0001 charged cancellation terminal rule: 400 capture − 24 fee = 376 expected", () => {
  assertEquals(resolveTerminalFeeDriverTenPence({
    captured_pence: 400,
    provider_fee_pence: 24,
    commission_pence: 0,
  }), 376);
  const built = buildFrDriverSettlementTripRow({
    trip: {
      id: "trip-1",
      trip_code: "MK-260825-001",
      status: "cancelled",
      financial_outcome: "CANCELLED_WITH_FEE",
      financial_model: "PLATFORM_COLLECTED",
      driver_net_pence: 400,
      commission_pence: 0,
    },
    session: {
      captured_amount_pence: 400,
      provider_processing_fee_pence: 24,
      captured_at: "2026-08-25T10:43:49.703Z",
    },
  });
  assertEquals(built.expected_entitlement_pence, 376);
});

function classifyDriverCreditPair(args: { expected: number; actual: number }): string {
  const variance = args.actual - args.expected;
  return classifyFrDriverCreditStatus({
    wallet_variance_pence: variance,
    expected_payable_pence: args.expected,
    missing_stamp_trip_count: 0,
    evaluable_trip_count: 1,
  });
}
