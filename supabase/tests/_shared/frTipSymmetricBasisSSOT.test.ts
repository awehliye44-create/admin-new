/**
 * FR tip symmetric-basis lock (MK-260912-005 regression).
 *
 * Expected entitlement adds confirmed non-commissionable tips, so the actual
 * wallet side must count trip-linked DRIVER_TIP_CREDIT exactly once — and must
 * not absorb unrelated bonuses, incentives, promotions or manual credits.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyFrDriverCreditStatus,
  computeFrDriverReconciliation,
  FR_TRIP_ENTITLEMENT_CREDIT_TYPES,
  isFrTripEntitlementCreditType,
  periodPayableVariancePence,
  sumActualWalletTripCreditsPence,
  sumExpectedPayablePence,
  sumUnlinkedTipCreditsPence,
} from "./frDriverReconciliationSSOT.ts";
import {
  resolveFrDriverExpectedEntitlement,
  type FrDriverSettlementTripForReconciliation,
} from "./frDriverExpectedEntitlementSSOT.ts";

/** Build an FR settlement trip row through the shared expected-entitlement SSOT. */
function trip(input: {
  trip_id: string;
  driver_net_pence: number | null;
  tip_pence?: number;
  commission_pence?: number;
  airport_charge_pence?: number;
  financial_model?: string;
}): FrDriverSettlementTripForReconciliation {
  const resolved = resolveFrDriverExpectedEntitlement({
    trip_id: input.trip_id,
    driver_net_pence: input.driver_net_pence,
    tip_pence: input.tip_pence ?? 0,
    commission_pence: input.commission_pence ?? null,
    airport_charge_pence: input.airport_charge_pence ?? 0,
    financial_model: input.financial_model ?? "PLATFORM_COLLECTED",
    completed_at: "2026-09-12T18:52:08.060Z",
  });
  return {
    trip_id: input.trip_id,
    driver_net_pence: input.driver_net_pence,
    expected_entitlement_pence: resolved.expected_entitlement_pence,
    expected_stamp_status: resolved.expected_stamp_status,
    financial_settled_at: resolved.financial_settled_at,
  };
}

const TRIP = "9a509aaf-bee1-44b7-bc06-8072cf910cbb";

function recon(args: {
  ledger: Array<{ type: string; amount_pence: number; related_trip_id?: string | null }>;
  settledTrips: Array<Record<string, unknown>>;
  finance_cleared_pence?: number;
}) {
  return computeFrDriverReconciliation({
    ledger: args.ledger,
    // deno-lint-ignore no-explicit-any
    settledTrips: args.settledTrips as any,
    completedPayoutItems: [],
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    finance_cleared_pence: args.finance_cleared_pence ?? 0,
    provider_account_balance_pence: 0,
    provider_account_balance_status: "AVAILABLE",
  });
}

Deno.test("1. fare only — expected 425, actual 425, difference 0", () => {
  const row = recon({
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "t1" },
      { type: "PLATFORM_COMMISSION", amount_pence: 75, related_trip_id: "t1" },
    ],
    settledTrips: [trip({ trip_id: "t1", driver_net_pence: 425, financial_model: "PLATFORM_COLLECTED" })],
  });
  assertEquals(row.expected_payable_pence, 425);
  assertEquals(row.actual_wallet_trip_credits_pence, 425);
  assertEquals(row.wallet_variance_pence, 0);
  assertEquals(row.driver_credit_status, "DRIVER_CREDIT_OK");
});

Deno.test("2. fare + £1 tip — expected 525, actual 525, difference 0, DRIVER_CREDIT_OK", () => {
  const row = recon({
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "t1" },
      { type: "DRIVER_TIP_CREDIT", amount_pence: 100, related_trip_id: "t1" },
    ],
    settledTrips: [trip({ trip_id: "t1",
      driver_net_pence: 425,
      tip_pence: 100,
      financial_model: "PLATFORM_COLLECTED", })],
  });
  assertEquals(row.expected_payable_pence, 525);
  assertEquals(row.actual_wallet_trip_credits_pence, 525);
  assertEquals(row.wallet_variance_pence, 0);
  assertEquals(row.driver_credit_status, "DRIVER_CREDIT_OK");
});

Deno.test("3. duplicate tip callback — single ledger credit counted once", () => {
  const actual = sumActualWalletTripCreditsPence([
    { type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "t1" },
    { type: "DRIVER_TIP_CREDIT", amount_pence: 100, related_trip_id: "t1" },
  ]);
  assertEquals(actual, 525);
});

Deno.test("4. unrelated bonus/incentive/promotion excluded from trip entitlement actual", () => {
  const actual = sumActualWalletTripCreditsPence([
    { type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "t1" },
    { type: "BONUS", amount_pence: 500 },
    { type: "INCENTIVE", amount_pence: 300 },
    { type: "PROMOTION", amount_pence: 200 },
  ]);
  assertEquals(actual, 425);
  assertEquals(isFrTripEntitlementCreditType("BONUS"), false);
  assertEquals(isFrTripEntitlementCreditType("DRIVER_TIP_CREDIT"), true);
});

Deno.test("5. manual credits stay adjustments, never trip entitlement actual", () => {
  const row = recon({
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "t1" },
      { type: "MANUAL_CREDIT", amount_pence: 900 },
    ],
    settledTrips: [trip({ trip_id: "t1", driver_net_pence: 425, financial_model: "PLATFORM_COLLECTED" })],
  });
  assertEquals(row.actual_wallet_trip_credits_pence, 425);
  assertEquals(row.wallet_adjustments_pence, 900);
  assertEquals(row.wallet_variance_pence, 0);
});

Deno.test("6. tip reversal follows existing ledger SSOT — no phantom entitlement", () => {
  const row = recon({
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "t1" },
      { type: "DRIVER_TIP_CREDIT", amount_pence: 100, related_trip_id: "t1" },
      { type: "LEDGER_REVERSAL", amount_pence: -100, related_trip_id: "t1" },
    ],
    settledTrips: [trip({ trip_id: "t1",
      driver_net_pence: 425,
      tip_pence: 100,
      financial_model: "PLATFORM_COLLECTED", })],
  });
  // Reversal is an adjustment in the existing SSOT; entitlement basis is unchanged.
  assertEquals(row.actual_wallet_trip_credits_pence, 525);
  assertEquals(row.wallet_adjustments_pence, -100);
  assertEquals(row.current_wallet_balance_pence, 425);
});

Deno.test("7. airport folded into driver_net counted once", () => {
  const expected = sumExpectedPayablePence([
    // deno-lint-ignore no-explicit-any
    trip({ trip_id: "t1", driver_net_pence: 850, financial_model: "PLATFORM_COLLECTED" }),
  ]);
  assertEquals(expected, 850);
  const actual = sumActualWalletTripCreditsPence([
    { type: "TRIP_EARNING_NET", amount_pence: 850, related_trip_id: "t1" },
  ]);
  assertEquals(periodPayableVariancePence({
    expected_payable_pence: expected,
    actual_ten_credits_pence: actual,
  }), 0);
});

Deno.test("8. fare + airport + tip — commission only on commissionable fare", () => {
  // Stored trip: fare 1000 commissionable, airport 500 non-commissionable,
  // commission 150 stored (dynamic rate), driver_net 1350, tip 100.
  const row = recon({
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 1350, related_trip_id: "t1" },
      { type: "PLATFORM_COMMISSION", amount_pence: 150, related_trip_id: "t1" },
      { type: "DRIVER_TIP_CREDIT", amount_pence: 100, related_trip_id: "t1" },
    ],
    settledTrips: [trip({ trip_id: "t1",
      driver_net_pence: 1350,
      commission_pence: 150,
      tip_pence: 100,
      financial_model: "PLATFORM_COLLECTED", })],
  });
  assertEquals(row.expected_payable_pence, 1450);
  assertEquals(row.actual_wallet_trip_credits_pence, 1450);
  assertEquals(row.wallet_variance_pence, 0);
});

Deno.test("9. dynamic wave commission — tip does not change commission", () => {
  const row = recon({
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 800, related_trip_id: "t1" },
      { type: "PLATFORM_COMMISSION", amount_pence: 200, related_trip_id: "t1" },
      { type: "DRIVER_TIP_CREDIT", amount_pence: 100, related_trip_id: "t1" },
    ],
    settledTrips: [trip({ trip_id: "t1",
      driver_net_pence: 800,
      commission_pence: 200,
      tip_pence: 100,
      financial_model: "PLATFORM_COLLECTED", })],
  });
  assertEquals(row.expected_payable_pence, 900);
  assertEquals(row.wallet_variance_pence, 0);
});

Deno.test("10/11. DRIVER_COLLECTED does not contaminate wallet reconciliation", () => {
  const platformTrip = trip({
    trip_id: "t1",
    driver_net_pence: 425,
    tip_pence: 100,
    financial_model: "PLATFORM_COLLECTED",
  });
  const commissionWalletTrip = trip({
    trip_id: "t2",
    driver_net_pence: 900,
    tip_pence: 100,
    financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
  });
  assertEquals(platformTrip.expected_entitlement_pence, 525);
  // Commission-wallet trips carry no wallet entitlement stamp at all.
  assertEquals(commissionWalletTrip.expected_entitlement_pence, null);
  assertEquals(commissionWalletTrip.expected_stamp_status, "EXPECTED_STAMP_MISSING");
  // Only the PLATFORM_COLLECTED trip contributes to expected payable.
  assertEquals(sumExpectedPayablePence([platformTrip, commissionWalletTrip]), 525);
});

Deno.test("12. MK-260912-005 fixture — 425 + 100 = 525, difference 0, wallet total 3319p", () => {
  const ledger = [
    { type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "a" },
    { type: "TRIP_EARNING_NET", amount_pence: 595, related_trip_id: "b" },
    { type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "c" },
    { type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: TRIP },
    { type: "DRIVER_TIP_CREDIT", amount_pence: 100, related_trip_id: TRIP },
    { type: "TRIP_EARNING_NET", amount_pence: 924, related_trip_id: "d" },
    { type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "e" },
  ];
  const settledTrips = [
    trip({ trip_id: "a", driver_net_pence: 425, financial_model: "PLATFORM_COLLECTED" }),
    trip({ trip_id: "b", driver_net_pence: 595, financial_model: "PLATFORM_COLLECTED" }),
    trip({ trip_id: "c", driver_net_pence: 425, financial_model: "PLATFORM_COLLECTED" }),
    trip({ trip_id: TRIP, driver_net_pence: 425, tip_pence: 100, financial_model: "PLATFORM_COLLECTED" }),
    trip({ trip_id: "d", driver_net_pence: 924, financial_model: "PLATFORM_COLLECTED" }),
    trip({ trip_id: "e", driver_net_pence: 425, financial_model: "PLATFORM_COLLECTED" }),
  ];
  assertEquals(
    sumActualWalletTripCreditsPence(ledger, new Set([TRIP])),
    525,
  );
  const row = recon({ ledger, settledTrips, finance_cleared_pence: 2894 });
  assertEquals(row.expected_payable_pence, 3319);
  assertEquals(row.actual_wallet_trip_credits_pence, 3319);
  assertEquals(row.wallet_variance_pence, 0);
  assertEquals(row.current_wallet_balance_pence, 3319);
  assertEquals(row.driver_credit_status, "DRIVER_CREDIT_OK");
});

Deno.test("13/14. drivers without tips unchanged", () => {
  const row = recon({
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 408, related_trip_id: "t1" },
      { type: "PLATFORM_COMMISSION", amount_pence: 72, related_trip_id: "t1" },
    ],
    settledTrips: [trip({ trip_id: "t1", driver_net_pence: 408, financial_model: "PLATFORM_COLLECTED" })],
  });
  assertEquals(row.actual_wallet_trip_credits_pence, 408);
  assertEquals(row.wallet_variance_pence, 0);
  assertEquals(row.driver_credit_status, "DRIVER_CREDIT_OK");
});

Deno.test("15. badge driver: variance 0 → OK, −100 → UNDER_CREDITED (sign convention kept)", () => {
  assertEquals(
    classifyFrDriverCreditStatus({
      wallet_variance_pence: 0,
      expected_payable_pence: 525,
      evaluable_trip_count: 1,
    }),
    "DRIVER_CREDIT_OK",
  );
  assertEquals(
    classifyFrDriverCreditStatus({
      wallet_variance_pence: -100,
      expected_payable_pence: 525,
      evaluable_trip_count: 1,
    }),
    "DRIVER_UNDER_CREDITED",
  );
});

Deno.test("16. untied tip credit is discretionary, not trip entitlement", () => {
  const ledger = [
    { type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "t1" },
    { type: "DRIVER_TIP_CREDIT", amount_pence: 100, related_trip_id: null },
  ];
  assertEquals(sumActualWalletTripCreditsPence(ledger), 425);
  assertEquals(sumUnlinkedTipCreditsPence(ledger), 100);
  assertEquals(FR_TRIP_ENTITLEMENT_CREDIT_TYPES.has("DRIVER_TIP_CREDIT"), true);
});
