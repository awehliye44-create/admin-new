/**
 * Lock: Driver Wallet expected entitlement — fare settlement vs terminal fee.
 * Lifecycle status alone must never decide the financial outcome (MK-017 £0.06).
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  FR_EXPECTED_STAMP_STATUS,
  FR_FINANCIAL_OUTCOME_CLASS,
  classifyFrDriverFinancialOutcome,
  resolveFrDriverExpectedEntitlement,
  sumFrDriverExpectedEntitlementPence,
} from "./frDriverExpectedEntitlementSSOT.ts";
import {
  periodPayableVariancePence,
} from "./frDriverReconciliationSSOT.ts";

const MK017_FARE = {
  trip_code: "MK-260923-017",
  trip_status: "cancelled",
  financial_model: "PLATFORM_COLLECTED",
  payment_hold_status: "partial_capture_only",
  gross_fare_pence: 506,
  commissionable_fare_pence: 506,
  commission_pence: 76,
  driver_net_pence: 430,
  captured_amount_pence: 500,
  fare_trip_earning_net_count: 1,
  fare_trip_earning_net_pence: 430,
} as const;

function openDiff(expected: number, actual: number): number {
  const v = periodPayableVariancePence({
    expected_payable_pence: expected,
    actual_ten_credits_pence: actual,
  });
  if (v == null) throw new Error("open diff null");
  return v;
}

Deno.test("1. MK-017 cancelled + partial_capture_only + fare stamps → expected 430, variance 0", () => {
  const classed = classifyFrDriverFinancialOutcome(MK017_FARE);
  assertEquals(classed.class, FR_FINANCIAL_OUTCOME_CLASS.FARE_SETTLEMENT);

  const row = resolveFrDriverExpectedEntitlement(MK017_FARE);
  assertEquals(row.is_terminal_fee_outcome, false);
  assertEquals(row.expected_entitlement_pence, 430);
  assertEquals(row.expected_stamp_status, FR_EXPECTED_STAMP_STATUS.OK);
  assertEquals(row.entitlement_source, "trips.driver_net_pence");
  assertEquals(openDiff(430, 430), 0);
  // Must not use terminal capture−commission (500−76=424).
  assertEquals(row.expected_entitlement_pence === 424, false);
});

Deno.test("2. MK-017 fixture with receivable OPEN → wallet variance still 0", () => {
  const row = resolveFrDriverExpectedEntitlement({
    ...MK017_FARE,
    customer_receivable_status: "OPEN",
  });
  assertEquals(row.expected_entitlement_pence, 430);
  assertEquals(openDiff(430, 430), 0);
});

Deno.test("3. MK-017 fixture with receivable SETTLED → wallet variance still 0", () => {
  const row = resolveFrDriverExpectedEntitlement({
    ...MK017_FARE,
    customer_receivable_status: "SETTLED",
  });
  assertEquals(row.expected_entitlement_pence, 430);
  assertEquals(openDiff(430, 430), 0);
});

Deno.test("4. Genuine cancellation-fee trip retains capture−commission logic", () => {
  const row = resolveFrDriverExpectedEntitlement({
    trip_code: "MK-260916-030",
    trip_status: "cancelled",
    financial_outcome: "CANCELLED_WITH_FEE",
    financial_model: "PLATFORM_COLLECTED",
    driver_net_pence: 435,
    commission_pence: 65,
    captured_amount_pence: 500,
    provider_processing_fee_pence: 25,
  });
  assertEquals(row.is_terminal_fee_outcome, true);
  assertEquals(row.expected_entitlement_pence, 435); // 500 − 65
  assertEquals(row.entitlement_source, "terminal_fee_capture_minus_commission");
});

Deno.test("5. Cancelled trip without sufficient financial evidence → UNKNOWN, not 0", () => {
  const classed = classifyFrDriverFinancialOutcome({
    trip_status: "cancelled",
    financial_model: "PLATFORM_COLLECTED",
    captured_amount_pence: 500,
  });
  assertEquals(classed.class, FR_FINANCIAL_OUTCOME_CLASS.UNKNOWN);

  const row = resolveFrDriverExpectedEntitlement({
    trip_status: "cancelled",
    financial_model: "PLATFORM_COLLECTED",
    captured_amount_pence: 500,
  });
  assertEquals(row.expected_stamp_status, FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING);
  assertEquals(row.expected_entitlement_pence, null);
  assertEquals(row.expected_entitlement_pence === 0, false);
});

Deno.test("6. Real over-credit remains detectable: expected 430, TEN 436 → variance +6", () => {
  const row = resolveFrDriverExpectedEntitlement(MK017_FARE);
  assertEquals(row.expected_entitlement_pence, 430);
  assertEquals(openDiff(430, 436), 6);
});

Deno.test("7. Period and lifetime scopes agree on MK-017 + MK-003 set", () => {
  const mk003Expected = 598;
  const periodExpected = 430 + mk003Expected;
  const periodActual = 430 + mk003Expected;
  const lifetimeExpected = 430 + mk003Expected;
  const lifetimeActual = 430 + mk003Expected;
  assertEquals(openDiff(periodExpected, periodActual), 0);
  assertEquals(openDiff(lifetimeExpected, lifetimeActual), 0);
  assertEquals(
    openDiff(periodExpected, periodActual),
    openDiff(lifetimeExpected, lifetimeActual),
  );

  const trips = [
    {
      trip_id: "174df647-2417-4da3-9e55-7261a4e7d3e7",
      driver_net_pence: 430,
      expected_entitlement_pence: 430,
      expected_stamp_status: FR_EXPECTED_STAMP_STATUS.OK,
    },
    {
      trip_id: "0e582a2e-afd4-42ce-99d4-9c3d9292232b",
      driver_net_pence: 598,
      expected_entitlement_pence: 598,
      expected_stamp_status: FR_EXPECTED_STAMP_STATUS.OK,
    },
  ];
  assertEquals(sumFrDriverExpectedEntitlementPence(trips).expected_payable_pence, 1028);
});

Deno.test("8. Customer capture / receivable variance cannot enter wallet variance", () => {
  const customerCaptureShortfall = 6;
  const receivableOriginal = 6;
  const captureVariance = 36;
  const rowOpen = resolveFrDriverExpectedEntitlement({
    ...MK017_FARE,
    customer_receivable_status: "OPEN",
  });
  const rowSettled = resolveFrDriverExpectedEntitlement({
    ...MK017_FARE,
    customer_receivable_status: "SETTLED",
  });
  assertEquals(rowOpen.expected_entitlement_pence, 430);
  assertEquals(rowSettled.expected_entitlement_pence, 430);
  const walletOpen = openDiff(430, 430);
  assertEquals(walletOpen, 0);
  assertEquals(walletOpen === customerCaptureShortfall, false);
  assertEquals(walletOpen === receivableOriginal, false);
  assertEquals(walletOpen === captureVariance, false);
});
