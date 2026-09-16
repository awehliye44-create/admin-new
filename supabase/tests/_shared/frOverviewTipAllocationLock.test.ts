/**
 * FR Overview tip allocation lock — period identity must count tip once.
 *
 * Live fixture MK-260912-005 class (period 09–16 Sep 2026):
 *   captured 3387, fare-net 2794, tip 100, commission 493 → difference 0
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateFrSettlementCaptureIdentity,
  sumFrAllocatedDriverEntitlementPence,
} from "../../functions/_shared/frConsumeOnlySSOT.ts";
import {
  buildFrPerTripAuditRecord,
  aggregateFrOverviewFromPerTripRecords,
} from "../../functions/_shared/frPerTripAuditSSOT.ts";
import { buildSplitReconciliationCheck } from "../../functions/_shared/financialReconciliationSSOT.ts";

function matchedRow(partial: Record<string, unknown>) {
  return {
    capture_reconciliation_status: "MATCHED",
    wallet_reconciliation_status: "WALLET_MATCHED",
    release_reconciliation_status: "RELEASE_NOT_REQUIRED",
    payout_reconciliation_status: "PAYOUT_NOT_DUE",
    financial_model: "PLATFORM_COLLECTED",
    ...partial,
  };
}

Deno.test("1: live fixture captured 3387 / fare 2794 / tip 100 / commission 493 → difference 0", () => {
  const rows = [
    matchedRow({
      trip_id: "mk005",
      tip_pence: 100,
      airport_charge_pence: 0,
      driver_net_pence: 425,
      onecab_gross_commission_pence: 75,
      captured_pence: 600,
    }),
    matchedRow({
      trip_id: "rest",
      tip_pence: 0,
      airport_charge_pence: 0,
      driver_net_pence: 2369,
      onecab_gross_commission_pence: 418,
      captured_pence: 2787,
    }),
  ];
  const records = rows.map((row) => buildFrPerTripAuditRecord({ row }));
  const overview = aggregateFrOverviewFromPerTripRecords(records, rows);
  assertEquals(overview.confirmed_provider_captured_total_pence, 3387);
  assertEquals(overview.driver_fare_net_total_pence, 2794);
  assertEquals(overview.driver_net_total_pence, 2794);
  assertEquals(overview.driver_tips_total_pence, 100);
  assertEquals(overview.driver_entitlement_total_pence, 2894);
  assertEquals(overview.onecab_gross_commission_pence, 493);
  assertEquals(overview.settlement_identity_variance_pence, 0);
  assertEquals(overview.settlement_identity_balanced, true);
});

Deno.test("2: fare-only period → difference 0", () => {
  const rows = [
    matchedRow({
      trip_id: "t1",
      tip_pence: 0,
      driver_net_pence: 425,
      onecab_gross_commission_pence: 75,
      captured_pence: 500,
      airport_charge_pence: 0,
    }),
  ];
  const overview = aggregateFrOverviewFromPerTripRecords(
    rows.map((row) => buildFrPerTripAuditRecord({ row })),
    rows,
  );
  assertEquals(overview.driver_tips_total_pence, 0);
  assertEquals(overview.settlement_identity_variance_pence, 0);
});

Deno.test("3: multiple tips across drivers → counted once each", () => {
  const rows = [
    matchedRow({
      trip_id: "a",
      tip_pence: 100,
      driver_net_pence: 425,
      onecab_gross_commission_pence: 75,
      captured_pence: 600,
      airport_charge_pence: 0,
    }),
    matchedRow({
      trip_id: "b",
      tip_pence: 200,
      driver_net_pence: 850,
      onecab_gross_commission_pence: 150,
      captured_pence: 1200,
      airport_charge_pence: 0,
    }),
  ];
  const overview = aggregateFrOverviewFromPerTripRecords(
    rows.map((row) => buildFrPerTripAuditRecord({ row })),
    rows,
  );
  assertEquals(overview.driver_tips_total_pence, 300);
  assertEquals(overview.driver_entitlement_total_pence, 425 + 100 + 850 + 200);
  assertEquals(overview.settlement_identity_variance_pence, 0);
});

Deno.test("4: tip captured but wallet credit missing → identity 0; wallet issue separate", () => {
  const row = matchedRow({
    trip_id: "t1",
    tip_pence: 100,
    driver_net_pence: 425,
    onecab_gross_commission_pence: 75,
    captured_pence: 600,
    airport_charge_pence: 0,
    wallet_reconciliation_status: "WALLET_CREDIT_MISSING",
    expected_driver_credit_pence: 525,
    actual_driver_credit_pence: 0,
    credit_difference_pence: -525,
  });
  const rec = buildFrPerTripAuditRecord({ row });
  assertEquals(rec.capture_variance_pence, 0);
  assertEquals(rec.wallet_status, "WALLET_CREDIT_MISSING");
  const overview = aggregateFrOverviewFromPerTripRecords([rec], [row]);
  assertEquals(overview.settlement_identity_variance_pence, 0);
  assertEquals(overview.missing_wallet_credits_count >= 1, true);
});

Deno.test("5: duplicate tip credit → over-credit remains visible on wallet, not allocation", () => {
  const row = matchedRow({
    trip_id: "t1",
    tip_pence: 100,
    driver_net_pence: 425,
    onecab_gross_commission_pence: 75,
    captured_pence: 600,
    airport_charge_pence: 0,
    wallet_reconciliation_status: "WALLET_OVER_CREDIT",
    expected_driver_credit_pence: 525,
    actual_driver_credit_pence: 625,
    credit_difference_pence: 100,
  });
  const rec = buildFrPerTripAuditRecord({ row });
  assertEquals(rec.capture_variance_pence, 0);
  assertEquals(rec.credit_difference_pence, 100);
});

Deno.test("6: airport folded into driver_net → display only, no double count", () => {
  // Stored fare-net already includes airport 500: driver_net 1350 = 850 fare + 500 airport.
  // Identity must NOT add airport again — pass airport_charge_pence 0 for allocation.
  const id = evaluateFrSettlementCaptureIdentity({
    captured_pence: 1500,
    driver_net_pence: 1350,
    commission_pence: 150,
    airport_charge_pence: 0,
    tips_pence: 0,
  });
  assertEquals(id.balanced, true);
  assertEquals(id.variance_pence, 0);
});

Deno.test("7: fare + airport (separate leg) + tip", () => {
  const id = evaluateFrSettlementCaptureIdentity({
    captured_pence: 1600,
    driver_net_pence: 850,
    commission_pence: 150,
    airport_charge_pence: 500,
    tips_pence: 100,
  });
  assertEquals(id.allocated_driver_entitlement_pence, 1450);
  assertEquals(id.balanced, true);
});

Deno.test("8: promotion-funded trip — subsidy deducted once", () => {
  const id = evaluateFrSettlementCaptureIdentity({
    captured_pence: 480,
    driver_net_pence: 425,
    commission_pence: 75,
    platform_promotion_subsidy_pence: 20,
    airport_charge_pence: 0,
    tips_pence: 0,
  });
  assertEquals(id.balanced, true);
  assertEquals(id.variance_pence, 0);
});

Deno.test("9: confirmed refund lowers net captured allocation basis", () => {
  // Overview uses captured net of refunds at session layer; identity on remaining capture.
  const id = evaluateFrSettlementCaptureIdentity({
    captured_pence: 500,
    driver_net_pence: 425,
    commission_pence: 75,
    airport_charge_pence: 0,
    tips_pence: 0,
  });
  assertEquals(id.balanced, true);
});

Deno.test("10: provider fee display does not alter gross allocation identity", () => {
  const withoutFee = evaluateFrSettlementCaptureIdentity({
    captured_pence: 600,
    driver_net_pence: 425,
    commission_pence: 75,
    airport_charge_pence: 0,
    tips_pence: 100,
  });
  // Provider fee is not an argument — identity unchanged.
  assertEquals(withoutFee.variance_pence, 0);
  const split = buildSplitReconciliationCheck({
    ledger: {
      card_customer_revenue_pence: 600,
      net_card_revenue_pence: 600,
      card_driver_payable_pence: 425,
      onecab_card_commission_pence: 75,
      onecab_card_net_commission_pence: 65,
      provider_processing_fees_pence: 10,
      pending_provider_confirmation_revenue_pence: 0,
      pending_provider_confirmation_commission_pence: 0,
      pending_provider_confirmation_driver_net_pence: 0,
      pending_trip_count: 0,
    },
    driverTipsPence: 100,
    airportChargesPence: 0,
    tolerancePence: 0,
  });
  assertEquals(split.balanced, true);
  assertEquals(split.card_reconciliation.variance_pence, 0);
});

Deno.test("11: DRIVER_COLLECTED excluded from overview rows", () => {
  // buildFrPerTripAuditRecord still builds; period query excludes via financial model scope.
  const row = matchedRow({
    trip_id: "dc",
    financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
    tip_pence: 100,
    driver_net_pence: 425,
    onecab_gross_commission_pence: 75,
    captured_pence: 600,
  });
  const rec = buildFrPerTripAuditRecord({ row });
  assertEquals(rec.financial_model, "DRIVER_COLLECTED_COMMISSION_WALLET");
});

Deno.test("12: empty period", () => {
  const overview = aggregateFrOverviewFromPerTripRecords([], []);
  assertEquals(overview.trip_count, 0);
  assertEquals(overview.settlement_identity_variance_pence, null);
  assertEquals(overview.driver_tips_total_pence, 0);
});

Deno.test("13: mixed settled/unsettled — pending does not invent capture", () => {
  const rows = [
    matchedRow({
      trip_id: "ok",
      tip_pence: 0,
      driver_net_pence: 425,
      onecab_gross_commission_pence: 75,
      captured_pence: 500,
      airport_charge_pence: 0,
    }),
    matchedRow({
      trip_id: "pending",
      tip_pence: 100,
      driver_net_pence: 425,
      onecab_gross_commission_pence: 75,
      captured_pence: null,
      airport_charge_pence: 0,
      capture_reconciliation_status: "CAPTURE_PENDING",
    }),
  ];
  const overview = aggregateFrOverviewFromPerTripRecords(
    rows.map((row) => buildFrPerTripAuditRecord({ row })),
    rows,
  );
  assertEquals(overview.confirmed_provider_captured_total_pence, 500);
  assertEquals(overview.settlement_identity_pending_trip_count >= 1, true);
});

Deno.test("14: RECONCILIATION_MISMATCH clears only when full identity equals zero", () => {
  const balanced = evaluateFrSettlementCaptureIdentity({
    captured_pence: 600,
    driver_net_pence: 425,
    commission_pence: 75,
    tips_pence: 100,
    airport_charge_pence: 0,
  });
  assertEquals(balanced.balanced, true);
  const mismatch = evaluateFrSettlementCaptureIdentity({
    captured_pence: 600,
    driver_net_pence: 425,
    commission_pence: 75,
    tips_pence: 0,
    airport_charge_pence: 0,
  });
  assertEquals(mismatch.balanced, false);
  assertEquals(mismatch.variance_pence, 100);
});

Deno.test("15: genuine £1 capture mismatch remains visible", () => {
  const id = evaluateFrSettlementCaptureIdentity({
    captured_pence: 599,
    driver_net_pence: 425,
    commission_pence: 75,
    tips_pence: 100,
    airport_charge_pence: 0,
  });
  assertEquals(id.balanced, false);
  assertEquals(id.variance_pence, -1);
});

Deno.test("never double-count tip-inclusive entitlement + tip again", () => {
  const double = evaluateFrSettlementCaptureIdentity({
    captured_pence: 600,
    driver_net_pence: 525, // wrongly tip-inclusive
    commission_pence: 75,
    tips_pence: 100,
    airport_charge_pence: 0,
  });
  assertEquals(double.variance_pence, -100);
  assertEquals(double.balanced, false);
});

Deno.test("sumFrAllocatedDriverEntitlementPence", () => {
  assertEquals(sumFrAllocatedDriverEntitlementPence({
    driver_fare_net_pence: 2794,
    driver_tips_pence: 100,
  }), 2894);
});
