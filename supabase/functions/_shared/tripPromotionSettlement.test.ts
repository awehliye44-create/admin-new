import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertSettlementCaptureIdentity,
  calculateTripSettlement,
  calculateTripSettlementFromTripRow,
  isPrePromotionFareEvidenceMissing,
  resolveLockedPromotionPence,
  resolveNegotiatedCommissionableFarePence,
  resolveOriginalPrePromotionRideFarePence,
  resolvePrePromotionCommissionableFarePence,
  resolvePreviousLockedPromotionPence,
  resolveCapturedTripEarningNetPence,
} from "./tripSettlement.ts";

const MK_260817_005 = {
  fare_snapshot_json: { gross_fare_pence: 500, original_fare_pence: 500 },
  locked_base_fare_pence: 500,
  offer_discount_pence: 50,
  discount_source: "global_offer",
  customer_modification_charge_pence: 249,
  gross_fare_pence: 749,
  final_fare_pence: 699,
  capture_amount_pence: 699,
  accepted_commission_percent: 15,
  airport_charge_pence: 0,
  pickup_waiting_charge_pence: 0,
};

/** MK-260818-001 — first post–Tier A promoted trip (no modifications). */
const MK_260818_001 = {
  fare_snapshot_json: { gross_fare_pence: 500, original_fare_pence: 500, pricing_source: "booking_post_commit" },
  locked_base_fare_pence: 500,
  offer_discount_pence: 20,
  discount_source: "global_offer",
  customer_modification_charge_pence: 0,
  gross_fare_pence: 500,
  final_fare_pence: 480,
  final_customer_fare_pence: 480,
  capture_amount_pence: 480,
  accepted_commission_percent: 15,
  airport_charge_pence: 0,
};

/** MK-260817-007 style — normal promoted trip, no modifications. */
const MK_260817_007 = {
  fare_snapshot_json: { gross_fare_pence: 500, original_fare_pence: 500 },
  locked_base_fare_pence: 500,
  offer_discount_pence: 20,
  discount_source: "global_offer",
  customer_modification_charge_pence: 0,
  final_fare_pence: 480,
  capture_amount_pence: 480,
  accepted_commission_percent: 15,
  airport_charge_pence: 0,
};

/** Stacked promoted trip — same settlement math, stacked accept stamps wave commission. */
const STACKED_PROMOTED = {
  ...MK_260817_007,
  fare_snapshot_json: {
    ...MK_260817_007.fare_snapshot_json,
    accepted_via: "accept_stacked_ride",
    accepted_commission_percent: 12,
  },
  accepted_commission_percent: 12,
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

Deno.test("MK-260818-001 exact fixture — canonical settlement dry-run", () => {
  const s = calculateTripSettlementFromTripRow(MK_260818_001)!;
  assertEquals(s.commissionable_fare_pence, 500);
  assertEquals(s.commission_pence, 75);
  assertEquals(s.driver_net_pence, 425);
  assertEquals(s.applied_customer_promotion_pence, 20);
  assertEquals(s.commission_after_promotion_pence, 55);
  const identity = assertSettlementCaptureIdentity({
    captured_pence: 480,
    driver_net_pence: s.driver_net_pence,
    commission_pence: s.commission_after_promotion_pence,
    airport_charge_pence: 0,
    tips_pence: 0,
  });
  assertEquals(identity.balanced, true);
  assertEquals(s.driver_net_pence + s.commission_after_promotion_pence, 480);
});

Deno.test("normal promoted trip — driver net from pre-promotion base only", () => {
  const s = calculateTripSettlementFromTripRow(MK_260817_007)!;
  assertEquals(s.commissionable_fare_pence, 500);
  assertEquals(s.commission_pence, 75);
  assertEquals(s.driver_net_pence, 425);
  assertEquals(s.commission_after_promotion_pence, 55);
});

Deno.test("stacked promoted trip — accepted dispatch-wave commission rate", () => {
  const s = calculateTripSettlementFromTripRow(STACKED_PROMOTED)!;
  assertEquals(s.commissionable_fare_pence, 500);
  assertEquals(s.tier_percent_used, 12);
  assertEquals(s.commission_pence, 60);
  assertEquals(s.driver_net_pence, 440);
  assertEquals(s.commission_after_promotion_pence, 40);
});

Deno.test("promotion applied once — locked promotion equals applied customer promotion", () => {
  const s = calculateTripSettlementFromTripRow(MK_260818_001)!;
  assertEquals(s.locked_promotion_pence, 20);
  assertEquals(s.applied_customer_promotion_pence, 20);
  assertEquals(s.driver_net_pence, 425);
});

Deno.test("promotion larger than commission — ONECAB subsidy, driver net unchanged", () => {
  const s = calculateTripSettlement({
    final_fare_pence: 549,
    pre_promotion_commissionable_fare_pence: 549,
    locked_promotion_pence: 54,
    driver_tier_commission_percent: 4,
    provider_fee_pence: 0,
    provider_fee_confirmed: true,
  });
  assertEquals(s.commission_pence, 22);
  assertEquals(s.commission_after_promotion_pence, -32);
  assertEquals(s.driver_net_pence, 527);
});

Deno.test("trip with full-price modifications — promotion does not discount modification charge", () => {
  assertEquals(resolvePrePromotionCommissionableFarePence(MK_260817_005), 749);
  const s = calculateTripSettlementFromTripRow(MK_260817_005)!;
  assertEquals(s.commissionable_fare_pence, 749);
  assertEquals(s.applied_customer_promotion_pence, 50);
});

Deno.test("F — MK-260818-002 promotion reduces ONECAB commission only; airport/tips non-commissionable", () => {
  const s = calculateTripSettlementFromTripRow({
    ...MK_260818_001,
    airport_charge_pence: 0,
  }, 0)!;
  assertEquals(s.commissionable_fare_pence, 500);
  assertEquals(s.commission_pence, 75);
  assertEquals(s.driver_net_pence, 425);
  assertEquals(s.applied_customer_promotion_pence, 20);
  assertEquals(s.commission_after_promotion_pence, 55);
  assertEquals(s.locked_promotion_pence, 20);
  const withAirport = calculateTripSettlementFromTripRow({
    ...MK_260818_001,
    airport_charge_pence: 200,
    final_fare_pence: 680,
    capture_amount_pence: 680,
  })!;
  assertEquals(withAirport.commissionable_fare_pence, 500);
  assertEquals(withAirport.driver_net_pence, 425);
  const withTip = calculateTripSettlement({
    final_fare_pence: 500,
    pre_promotion_commissionable_fare_pence: 500,
    locked_promotion_pence: 20,
    tips_pence: 100,
    driver_tier_commission_percent: 15,
  });
  assertEquals(withTip.driver_net_pence, 425);
  assertEquals(withTip.tips_pence, 100);
  assertEquals(withTip.driver_total_earnings_pence, 525);
});

Deno.test("wallet entitlement for MK-260818-001 is 425p", () => {
  const credit = resolveCapturedTripEarningNetPence({
    trip: MK_260818_001,
    captureAmountPence: 480,
  });
  assertEquals(credit.driverNetPence, 425);
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

/** Step 2A.1 — A: missing promoted-fare evidence fails closed (TS mirror of SQL). */
Deno.test("A — missing promoted-fare evidence: no settlement from discounted fare", () => {
  const missingEvidence = {
    discount_source: "global_offer",
    offer_discount_pence: 20,
    final_fare_pence: 480,
    final_customer_fare_pence: 480,
    fare_snapshot_json: {},
    locked_base_fare_pence: 0,
    accepted_commission_percent: 15,
  };
  assertEquals(isPrePromotionFareEvidenceMissing(missingEvidence), true);
  assertEquals(calculateTripSettlementFromTripRow(missingEvidence), null);
  assertEquals(resolvePrePromotionCommissionableFarePence(missingEvidence), 0);
});

/** Step 2A.1 — B: negotiated fare supersedes prior promotion (520p, 15% → 78/442). */
Deno.test("B — negotiated fare: no double discount, audit retains prior 20p promo", () => {
  const negotiated = {
    discount_source: "global_offer",
    offer_discount_pence: 20,
    locked_offer_type: "negotiated_offer",
    accepted_driver_offer_fare_pence: 520,
    final_fare_pence: 520,
    final_customer_fare_pence: 520,
    accepted_commission_percent: 15,
    fare_snapshot_json: {
      fare_source: "negotiated",
      negotiated_commissionable_fare_pence: 520,
      previous_locked_promotion_pence: 20,
      promotion_application_status: "SUPERSEDED_BY_NEGOTIATION",
      original_fare_pence: 500,
      gross_fare_pence: 500,
    },
  };
  assertEquals(resolveLockedPromotionPence(negotiated), 0);
  assertEquals(resolvePreviousLockedPromotionPence(negotiated), 20);
  const s = calculateTripSettlementFromTripRow(negotiated)!;
  assertEquals(s.commissionable_fare_pence, 520);
  assertEquals(s.commission_pence, 78);
  assertEquals(s.driver_net_pence, 442);
  assertEquals(s.applied_customer_promotion_pence, 0);
  assertEquals(s.commission_after_promotion_pence, 78);
  assertEquals(negotiated.final_customer_fare_pence, 520);
});

/** Step 2A.1 — C: negotiated base + full-price modification. */
Deno.test("C — negotiated fare plus later modification: commissionable 620p, promo 0", () => {
  const withMod = {
    discount_source: "global_offer",
    offer_discount_pence: 20,
    locked_offer_type: "negotiated_offer",
    accepted_driver_offer_fare_pence: 520,
    final_fare_pence: 620,
    final_customer_fare_pence: 620,
    customer_modification_charge_pence: 100,
    accepted_commission_percent: 15,
    fare_snapshot_json: {
      fare_source: "negotiated",
      negotiated_commissionable_fare_pence: 520,
      promotion_application_status: "SUPERSEDED_BY_NEGOTIATION",
    },
  };
  assertEquals(resolveNegotiatedCommissionableFarePence(withMod), 620);
  const s = calculateTripSettlementFromTripRow(withMod)!;
  assertEquals(s.commissionable_fare_pence, 620);
  assertEquals(s.applied_customer_promotion_pence, 0);
  assertEquals(s.commission_pence, 93);
  assertEquals(s.driver_net_pence, 527);
});

/** Step 2A.1 — D: idempotent re-settlement (concurrency mirror — same stamps). */
Deno.test("D — repeated settlement from same row is idempotent", () => {
  const first = calculateTripSettlementFromTripRow(MK_260818_001)!;
  const second = calculateTripSettlementFromTripRow(MK_260818_001)!;
  assertEquals(first.commissionable_fare_pence, second.commissionable_fare_pence);
  assertEquals(first.commission_pence, second.commission_pence);
  assertEquals(first.driver_net_pence, second.driver_net_pence);
});

/** Step 2A.1 — E: existing promoted trip unchanged formula (500/20/15% → 425/55/480). */
Deno.test("E — existing promoted trip MK-260818-001 canonical settlement", () => {
  const s = calculateTripSettlementFromTripRow(MK_260818_001)!;
  assertEquals(s.commissionable_fare_pence, 500);
  assertEquals(s.commission_pence, 75);
  assertEquals(s.driver_net_pence, 425);
  assertEquals(s.applied_customer_promotion_pence, 20);
  assertEquals(s.commission_after_promotion_pence, 55);
  assertEquals(s.driver_net_pence + s.commission_after_promotion_pence, 480);
});
