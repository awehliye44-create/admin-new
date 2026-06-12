import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calculateTripSettlement,
  calculateTripSettlementFromTripRow,
  SETTLEMENT_FORMULA_VERSION,
} from "./tripSettlement.ts";

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

Deno.test("Test 3 — Tip: final £10.00, tip £2.00; Stripe fee does not reduce driver", () => {
  const s = calculateTripSettlement({
    final_fare_pence: 1000,
    tips_pence: 200,
    driver_tier_commission_percent: 15,
    stripe_fee_pence: 29,
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
    stripe_fee_pence: 29,
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
