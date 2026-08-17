import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calculateTripSettlement,
  calculateTripSettlementFromTripRow,
  resolveLockedPromotionPence,
  resolveOriginalPrePromotionRideFarePence,
  resolvePrePromotionCommissionableFarePence,
  resolveCapturedTripEarningNetPence,
} from "./tripSettlement.ts";

const MK_260817_005 = {
  fare_snapshot_json: { gross_fare_pence: 500 },
  locked_base_fare_pence: 500,
  offer_discount_pence: 50,
  discount_source: "global_offer",
  customer_modification_charge_pence: 249,
  gross_fare_pence: 749,
  capture_amount_pence: 699,
  accepted_commission_percent: 15,
  airport_charge_pence: 0,
  pickup_waiting_charge_pence: 0,
};

Deno.test("1 — existing fields: original fare 500p, locked promotion 50p", () => {
  assertEquals(resolveOriginalPrePromotionRideFarePence(MK_260817_005), 500);
  assertEquals(resolveLockedPromotionPence(MK_260817_005), 50);
});

Deno.test("2 — modification +249p full price; promotion stays 50p; commissionable 749p not 998p", () => {
  assertEquals(resolvePrePromotionCommissionableFarePence(MK_260817_005), 749);
  const doubled = 749 + 249;
  assertEquals(doubled, 998);
  assertEquals(resolvePrePromotionCommissionableFarePence(MK_260817_005) === 998, false);
  assertEquals(resolveLockedPromotionPence(MK_260817_005), 50);
});

Deno.test("3 — MK-260817-005 settlement: capture 699, commission 112, driver 637, after promo 62, fee 27 → net 35", () => {
  const s = calculateTripSettlementFromTripRow(MK_260817_005, 27, {
    provider_fee_confirmed: true,
  })!;
  assertEquals(s.commissionable_fare_pence, 749);
  assertEquals(s.commission_pence, 112);
  assertEquals(s.driver_net_pence, 637);
  assertEquals(s.locked_promotion_pence, 50);
  assertEquals(s.commission_after_promotion_pence, 62);
  assertEquals(s.onecab_net_pence, 35);
});

Deno.test("provider fee — null/unconfirmed is PENDING; confirmed zero is £0; negative net preserved", () => {
  const pending = calculateTripSettlementFromTripRow(MK_260817_005, 0, {
    provider_fee_confirmed: false,
  })!;
  assertEquals(pending.onecab_net_pence, null);

  const zero = calculateTripSettlement({
    final_fare_pence: 749,
    pre_promotion_commissionable_fare_pence: 749,
    locked_promotion_pence: 50,
    driver_tier_commission_percent: 15,
    provider_fee_pence: 0,
    provider_fee_confirmed: true,
  });
  assertEquals(zero.provider_fee_pence, 0);
  assertEquals(zero.onecab_net_pence, 62);

  const negative = calculateTripSettlement({
    final_fare_pence: 549,
    pre_promotion_commissionable_fare_pence: 549,
    locked_promotion_pence: 54,
    driver_tier_commission_percent: 4,
    provider_fee_pence: 25,
    provider_fee_confirmed: true,
  });
  assertEquals(negative.commission_pence, 22);
  assertEquals(negative.commission_after_promotion_pence, -32);
  assertEquals(negative.onecab_net_pence, -57);
});

Deno.test("waiting is not added to the promotion commissionable base", () => {
  const withWaiting = {
    ...MK_260817_005,
    pickup_waiting_charge_pence: 7,
  };
  assertEquals(resolvePrePromotionCommissionableFarePence(withWaiting), 749);
});

Deno.test("wallet entitlement for MK-260817-005 is 637p", () => {
  const credit = resolveCapturedTripEarningNetPence({
    trip: MK_260817_005,
    captureAmountPence: 699,
  });
  assertEquals(credit.driverNetPence, 637);
});
