import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calculateTripSettlement,
  calculateTripSettlementFromTripRow,
  resolveTripTierPercent,
  SETTLEMENT_FORMULA_VERSION,
} from "./tripSettlement.ts";
import { resolveCapturedTripEarningNetPence } from "./tripSettlement.ts";

Deno.test("Test 1 — Normal trip: final £10.00, tier 15%", () => {
  const s = calculateTripSettlement({
    final_fare_pence: 1000,
    driver_tier_commission_percent: 15,
  });
  assertEquals(s.commission_pence, 150);
  assertEquals(s.driver_net_pence, 850);
  assertEquals(s.driver_total_earnings_pence, 850);
  assertEquals(s.formula_version, SETTLEMENT_FORMULA_VERSION);
});

Deno.test("Test 2 — Airport/pass-through: final £20.00, airport £5.00", () => {
  const s = calculateTripSettlement({
    final_fare_pence: 2000,
    airport_charge_pence: 500,
    driver_tier_commission_percent: 15,
  });
  assertEquals(s.commissionable_fare_pence, 1500);
  assertEquals(s.commission_pence, 225);
  assertEquals(s.driver_net_pence, 1275);
  assertEquals(s.driver_total_earnings_pence, 1775);
});

Deno.test("Test 3 — Tip: final £10.00, tip £2.00; provider fee does not reduce driver", () => {
  const s = calculateTripSettlement({
    final_fare_pence: 1000,
    tips_pence: 200,
    driver_tier_commission_percent: 15,
    provider_fee_pence: 29,
  });
  assertEquals(s.commission_pence, 150);
  assertEquals(s.driver_total_earnings_pence, 1050);
  assertEquals(s.driver_net_pence, 850);
  assertEquals(s.platform_net_revenue_pence, 150 - 29);
  assertEquals(s.driver_total_earnings_pence, s.driver_net_pence + s.tips_pence);
});

Deno.test("Test 4 — Negotiated: commission from £5.70, driver total = £5.70 − commission", () => {
  const s = calculateTripSettlement({
    final_fare_pence: 570,
    driver_tier_commission_percent: 15,
  });
  assertEquals(s.commissionable_fare_pence, 570);
  assertEquals(s.commission_pence, 86);
  assertEquals(s.driver_total_earnings_pence, 570 - 86);
  assertEquals(s.driver_net_pence, 484);
});

Deno.test("Test 5 — Admin edit: fare £10.00 → £12.00 recalculated", () => {
  const before = calculateTripSettlement({
    final_fare_pence: 1000,
    driver_tier_commission_percent: 15,
  });
  const after = calculateTripSettlement({
    final_fare_pence: 1200,
    driver_tier_commission_percent: 15,
  });
  assertEquals(before.commission_pence, 150);
  assertEquals(after.commission_pence, 180);
  assertEquals(after.driver_net_pence, 1020);
  assertEquals(after.driver_total_earnings_pence, 1020);
});

Deno.test("Test 6 — Webhook recovery matches direct settlement", () => {
  const direct = calculateTripSettlement({
    final_fare_pence: 1000,
    airport_charge_pence: 0,
    tips_pence: 200,
    driver_tier_commission_percent: 15,
    provider_fee_pence: 29,
  });
  const fromRow = calculateTripSettlementFromTripRow(
    {
      final_fare_pence: 1000,
      airport_charge_pence: 0,
      tip_pence: 200,
      driver_tier_commission_percent: 15,
    },
    29,
  );
  assertEquals(fromRow?.commission_pence, direct.commission_pence);
  assertEquals(fromRow?.driver_net_pence, direct.driver_net_pence);
  assertEquals(fromRow?.driver_total_earnings_pence, direct.driver_total_earnings_pence);
  assertEquals(fromRow?.platform_net_revenue_pence, direct.platform_net_revenue_pence);
});

Deno.test("accepted snapshot 10% — £20 fare, no airport, no tip", () => {
  const s = calculateTripSettlement({
    final_fare_pence: 2000,
    driver_tier_commission_percent: 10,
  });
  assertEquals(s.commissionable_fare_pence, 2000);
  assertEquals(s.commission_pence, 200);
  assertEquals(s.driver_net_pence, 1800);
  assertEquals(s.driver_total_earnings_pence, 1800);
});

Deno.test("airport fee is excluded from commissionable and added back in full", () => {
  const s = calculateTripSettlement({
    final_fare_pence: 2600,
    airport_charge_pence: 600,
    driver_tier_commission_percent: 10,
  });
  assertEquals(s.commissionable_fare_pence, 2000);
  assertEquals(s.commission_pence, 200);
  assertEquals(s.driver_net_pence, 1800);
  assertEquals(s.driver_total_earnings_pence, 2400);
});

Deno.test("airport + tip — commission on fare only; tip and airport pass through", () => {
  const s = calculateTripSettlement({
    final_fare_pence: 2600,
    airport_charge_pence: 600,
    tips_pence: 200,
    driver_tier_commission_percent: 10,
  });
  assertEquals(s.commission_pence, 200);
  assertEquals(s.driver_total_earnings_pence, 2600);
});

Deno.test("wave-reduced accepted 9% on £20", () => {
  const s = calculateTripSettlement({
    final_fare_pence: 2000,
    driver_tier_commission_percent: 9,
  });
  assertEquals(s.commission_pence, 180);
  assertEquals(s.driver_net_pence, 1820);
});

Deno.test("accepted 0% wave credits the full commissionable fare", () => {
  const s = calculateTripSettlement({
    final_fare_pence: 2000,
    driver_tier_commission_percent: 0,
  });
  assertEquals(s.commission_pence, 0);
  assertEquals(s.driver_net_pence, 2000);
  assertEquals(s.driver_total_earnings_pence, 2000);
});

Deno.test("resolveTripTierPercent prefers accepted snapshot after Admin changes", () => {
  assertEquals(
    resolveTripTierPercent({
      accepted_commission_percent: 9,
      driver_tier_commission_percent: 15,
      commission_pct: 15,
    }),
    9,
  );
  assertEquals(
    resolveTripTierPercent({
      accepted_commission_percent: 0,
      driver_tier_commission_percent: 15,
    }),
    0,
  );
});

Deno.test("Revolut provider fee reduces ONECAB net only", () => {
  const s = calculateTripSettlement({
    final_fare_pence: 2600,
    airport_charge_pence: 600,
    tips_pence: 200,
    driver_tier_commission_percent: 10,
    provider_fee_pence: 29,
  });
  assertEquals(s.driver_net_pence, 1800);
  assertEquals(s.driver_total_earnings_pence, 2600);
  assertEquals(s.platform_gross_revenue_pence, 200);
  assertEquals(s.platform_net_revenue_pence, 171);
});

Deno.test("MK-260815-010 reconstruction — accepted W2 4% on 495p", () => {
  const s = calculateTripSettlementFromTripRow({
    final_fare_pence: 495,
    capture_amount_pence: 495,
    airport_charge_pence: 0,
    tip_pence: 0,
    accepted_commission_percent: 4,
    driver_tier_commission_percent: 15,
  });
  assertEquals(s?.commissionable_fare_pence, 495);
  assertEquals(s?.commission_pence, 20);
  assertEquals(s?.driver_net_pence, 475);
  const wallet = resolveCapturedTripEarningNetPence({
    trip: {
      final_fare_pence: 495,
      airport_charge_pence: 0,
      accepted_commission_percent: 4,
      driver_tier_commission_percent: 15,
    },
    captureAmountPence: 495,
    tipPence: 0,
  });
  assertEquals(wallet.driverNetPence, 475);
  assertEquals(wallet.commissionPct, 4);
});

Deno.test("wallet credit includes airport and respects 0% accepted snapshot", () => {
  const airport = resolveCapturedTripEarningNetPence({
    trip: {
      final_fare_pence: 2600,
      airport_charge_pence: 600,
      accepted_commission_percent: 10,
    },
    captureAmountPence: 2600,
    tipPence: 0,
  });
  assertEquals(airport.driverNetPence, 2400);
  assertEquals(airport.commissionPct, 10);

  const zero = resolveCapturedTripEarningNetPence({
    trip: {
      final_fare_pence: 2000,
      airport_charge_pence: 0,
      accepted_commission_percent: 0,
      driver_net_pence: 0,
    },
    captureAmountPence: 2000,
  });
  assertEquals(zero.driverNetPence, 2000);
  assertEquals(zero.commissionPct, 0);
});
