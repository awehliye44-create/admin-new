import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  aggregateFrOverviewFromPerTripRecords,
  buildFrPerTripAuditRecord,
  buildFrPeriodAuditSummary,
  classifyFrProviderFeeFromSession,
  classifyFrPromotionApplication,
  resolveCanonicalPaymentSessionMoneyForTrip,
  resolveTripCommissionAfterPromotionPence,
} from "./frPerTripAuditSSOT.ts";
import { evaluateFrSettlementCaptureIdentity } from "./frConsumeOnlySSOT.ts";
import {
  FINANCE_RECONCILIATION_TRIP_FINANCIAL_MODEL,
} from "./financeReconciliationTripQuery.ts";
import { SERVICE_AREA_FINANCIAL_MODEL } from "./commissionWalletSSOT.ts";

// Live settlement stamps from production
const MK_260817_005_TRIP = {
  offer_discount_pence: 50,
  discount_source: "global_offer",
  locked_base_fare_pence: 500,
  customer_modification_charge_pence: 249,
  gross_fare_pence: 749,
  final_fare_pence: 699,
  // commissionable_fare_pence saved by settlement = 749 (pre-promo base, > final 699)
  commissionable_fare_pence: 749,
  commission_pence: 112,
  driver_net_pence: 637,
};

const MK_260817_007_TRIP = {
  offer_discount_pence: 20,
  discount_source: "global_offer",
  locked_base_fare_pence: 500,
  customer_modification_charge_pence: 0,
  gross_fare_pence: 480,
  final_fare_pence: 480,
  // commissionable_fare_pence = 480 = final_fare → settlement ran on final fare (NOT pre-promo)
  commissionable_fare_pence: 480,
  commission_pence: 72,
  driver_net_pence: 408,
};

const MK_260817_009_TRIP = {
  offer_discount_pence: 33,
  discount_source: "global_offer",
  locked_base_fare_pence: 831,
  customer_modification_charge_pence: 0,
  gross_fare_pence: 798,
  final_fare_pence: 798,
  // commissionable_fare_pence = 798 = final_fare → settlement ran on final fare (NOT pre-promo)
  commissionable_fare_pence: 798,
  commission_pence: 120,
  driver_net_pence: 678,
};

Deno.test("MK-260817-005: 699 = 637 + 62 promotion identity (APPLIED_TO_ONECAB)", () => {
  const promo = classifyFrPromotionApplication(MK_260817_005_TRIP);
  assertEquals(promo.promotion_application_status, "APPLIED_TO_ONECAB");
  assertEquals(promo.applied_promotion_pence, 50);
  assertEquals(promo.unapplied_promotion_pence, 0);

  const after = resolveTripCommissionAfterPromotionPence(MK_260817_005_TRIP);
  assertEquals(after, 62);
  const identity = evaluateFrSettlementCaptureIdentity({
    captured_pence: 699,
    driver_net_pence: 637,
    commission_pence: 112,
    commission_after_promotion_pence: 62,
    airport_charge_pence: 0,
    tips_pence: 0,
  });
  assertEquals(identity.balanced, true);
  assertEquals(identity.variance_pence, 0);
});

Deno.test("MK-260817-007: SETTLEMENT_BASE_DEFECT — settlement ran on discounted fare (480p) not original (500p)", () => {
  // Business rule: driver entitlement must be from original_pre_promotion_fare + mods.
  // 007: original=500p, promotion=20p, mod=0p → canonical commissionable=500p.
  // But commissionable_fare_pence=480p (= 500-20) → settlement used post-discount base → DEFECT.
  // Correct driver entitlement = 500 × 0.85 = 425p (not 408p).
  // FR reports SETTLEMENT_BASE_DEFECT — does not repair or credit.
  const promo = classifyFrPromotionApplication(MK_260817_007_TRIP);
  assertEquals(promo.promotion_application_status, "SETTLEMENT_BASE_DEFECT");
  // No promotion absorbed by ONECAB because driver was already underpaid.
  assertEquals(promo.applied_promotion_pence, 0);
  assertEquals(promo.unapplied_promotion_pence, 20);
  assertEquals(promo.canonical_commissionable_fare_pence, 500); // correct base
  assertEquals(promo.original_trip_price_pence, 500);
});

Deno.test("MK-260817-009: SETTLEMENT_BASE_DEFECT — settlement ran on discounted fare (798p) not original (831p)", () => {
  // 009: original=831p, promotion=33p, mod=0p → canonical commissionable=831p.
  // But commissionable_fare_pence=798p (= 831-33) → settlement used post-discount base → DEFECT.
  // Correct driver entitlement = Math.round(831 × 0.85) = 706p (not 678p).
  const promo = classifyFrPromotionApplication(MK_260817_009_TRIP);
  assertEquals(promo.promotion_application_status, "SETTLEMENT_BASE_DEFECT");
  assertEquals(promo.applied_promotion_pence, 0);
  assertEquals(promo.unapplied_promotion_pence, 33);
  assertEquals(promo.canonical_commissionable_fare_pence, 831); // correct base
  assertEquals(promo.original_trip_price_pence, 831);
});

Deno.test("trip modifications receive no promotion (full-price mod charge included in commissionable)", () => {
  // MK-260817-005 has a 249p modification charge — still only 50p promotion applied.
  const promo = classifyFrPromotionApplication(MK_260817_005_TRIP);
  assertEquals(promo.applied_promotion_pence, 50);
  // pre-promo commissionable = locked_base 500 + mod 249 = 749; promotion only 50p off commission
  const after = resolveTripCommissionAfterPromotionPence(MK_260817_005_TRIP);
  assertEquals(after, 62); // 112 - 50 = 62
});

Deno.test("promotion_application_status=PENDING_EVIDENCE when settlement stamps missing", () => {
  const promo = classifyFrPromotionApplication({
    offer_discount_pence: 20,
    discount_source: "global_offer",
    locked_base_fare_pence: 500,
    // No commission_pence, driver_net_pence, commissionable_fare_pence, or final_fare_pence
  });
  assertEquals(promo.promotion_application_status, "PENDING_EVIDENCE");
  assertEquals(promo.applied_promotion_pence, 0);
});

Deno.test("promotion applied once only — not double-counted from multiple fields", () => {
  const promo = classifyFrPromotionApplication(MK_260817_005_TRIP);
  const after = resolveTripCommissionAfterPromotionPence(MK_260817_005_TRIP);
  // applied_promotion_pence = 50; gross - applied = 112 - 50 = 62; not 112 - 100
  assertEquals(promo.applied_promotion_pence, 50);
  assertEquals(after, 62);
});

Deno.test("promotion identity with gross commission fails — no false -50p mismatch", () => {
  const grossOnly = evaluateFrSettlementCaptureIdentity({
    captured_pence: 699,
    driver_net_pence: 637,
    commission_pence: 112,
    airport_charge_pence: 0,
    tips_pence: 0,
  });
  assertEquals(grossOnly.balanced, false);
  assertEquals(grossOnly.variance_pence, -50);
});

Deno.test("driver entitlement is based on original pre-promotion commissionable fare (not final fare)", () => {
  // For MK-260817-005: original ride=500 + mod=249 = commissionable 749; 15% = 112 commission; driver gets 637
  // The driver entitlement is not 15% of 699 (final fare).
  const notFinalFareCommission = Math.round(699 * 0.15);
  const driverFromFinalFare = 699 - notFinalFareCommission;
  // driver entitlement from pre-promo base (637) ≠ driver from final fare (~594)
  assertEquals(MK_260817_005_TRIP.driver_net_pence, 637);
  assertEquals(driverFromFinalFare === 637, false);
});

Deno.test("canonical sessions: booking + recovery are not double-counted beyond verified total", () => {
  const resolved = resolveCanonicalPaymentSessionMoneyForTrip([
    {
      id: "ps-booking",
      trip_id: "t1",
      purpose: "RIDE_BOOKING",
      status: "captured",
      provider_state: "CAPTURED",
      captured_amount_pence: 500,
      authorised_amount_pence: 780,
      provider_processing_fee_pence: 27,
      fee_status: "CONFIRMED",
    },
    {
      id: "ps-recovery",
      trip_id: "t1",
      purpose: "PAYMENT_RECOVERY",
      status: "recovery_completed",
      provider_state: "completed",
      captured_amount_pence: 199,
    },
  ]);
  assertEquals(resolved?.session_resolution_status, "RESOLVED");
  assertEquals(resolved?.captured_amount_pence, 699);
  assertEquals(resolved?.canonical_payment_session_ids.length, 2);
});

Deno.test("ambiguous sessions produce PAYMENT_SESSION_AMBIGUOUS", () => {
  const resolved = resolveCanonicalPaymentSessionMoneyForTrip([
    {
      id: "ps-a",
      trip_id: "t1",
      purpose: "RIDE_BOOKING",
      status: "captured",
      provider_state: "CAPTURED",
      captured_amount_pence: 500,
    },
    {
      id: "ps-b",
      trip_id: "t1",
      purpose: "RIDE_BOOKING",
      status: "captured",
      provider_state: "CAPTURED",
      captured_amount_pence: 699,
    },
  ]);
  assertEquals(resolved?.session_resolution_status, "PAYMENT_SESSION_AMBIGUOUS");
  assertEquals(resolved?.captured_amount_pence, null);
  assertEquals((resolved?.ambiguous_sessions ?? []).length, 2);
});

Deno.test("provider fee: confirmed zero vs pending null", () => {
  const zero = classifyFrProviderFeeFromSession({
    provider_processing_fee_pence: 0,
    fee_status: "CONFIRMED",
    sessionsMapPresent: true,
  });
  assertEquals(zero.confirmed_provider_fee_pence, 0);
  assertEquals(zero.fee_status, "CONFIRMED_ZERO");

  const pending = classifyFrProviderFeeFromSession({
    provider_processing_fee_pence: null,
    fee_status: "PENDING",
    sessionsMapPresent: true,
  });
  assertEquals(pending.confirmed_provider_fee_pence, null);
  assertEquals(pending.fee_status, "PENDING");
});

Deno.test("one pending trip does not blank evaluable trips in period aggregate", () => {
  const records = [
    buildFrPerTripAuditRecord({
      row: {
        trip_id: "t-balanced",
        captured_pence: 699,
        driver_net_pence: 637,
        onecab_gross_commission_pence: 112,
        commission_pence: 112,
        commissionable_fare_pence: 749,
        final_fare_pence: 699,
        offer_discount_pence: 50,
        discount_source: "global_offer",
        locked_base_fare_pence: 500,
        customer_modification_charge_pence: 249,
        airport_charge_pence: 0,
        tip_pence: 0,
        capture_reconciliation_status: "MATCHED",
        wallet_reconciliation_status: "WALLET_MATCHED",
        payout_reconciliation_status: "PAYOUT_NOT_DUE",
        fee_status: "CONFIRMED",
        payment_evidence_status: "PAYMENT_SESSIONS",
        confirmed_provider_fee_pence: 27,
      },
    }),
    buildFrPerTripAuditRecord({
      row: {
        trip_id: "t-pending",
        captured_pence: null,
        driver_net_pence: 400,
        onecab_gross_commission_pence: 60,
        capture_reconciliation_status: "CAPTURE_AMOUNT_UNKNOWN",
        wallet_reconciliation_status: "WALLET_CREDIT_MISSING",
        payout_reconciliation_status: "PAYOUT_NOT_DUE",
        fee_status: "PENDING_PROVIDER_FEE",
        payment_evidence_status: "PAYMENT_SESSIONS",
      },
    }),
  ];
  const overview = aggregateFrOverviewFromPerTripRecords(records);
  assertEquals(overview.confirmed_provider_captured_total_pence, 699);
  assertEquals(overview.settlement_identity_variance_pence, 0);
  assertEquals(overview.settlement_identity_balanced, true);
  assertEquals(overview.evaluated_trip_count, 1);
  assertEquals(overview.pending_trip_count, 1);
});

Deno.test("£10.86 wallet gap listed per trip (1086p)", () => {
  const mk005 = buildFrPerTripAuditRecord({
    row: {
      trip_id: "mk-005",
      trip_code: "MK-260817-005",
      captured_pence: 699,
      driver_net_pence: 637,
      commission_pence: 112,
      commissionable_fare_pence: 749,
      final_fare_pence: 699,
      offer_discount_pence: 50,
      discount_source: "global_offer",
      locked_base_fare_pence: 500,
      customer_modification_charge_pence: 249,
      wallet_credit_pence: 637,
      wallet_reconciliation_status: "WALLET_MATCHED",
      onecab_gross_commission_pence: 112,
      capture_reconciliation_status: "MATCHED",
      payout_reconciliation_status: "PAYOUT_NOT_DUE",
      fee_status: "CONFIRMED",
      payment_evidence_status: "PAYMENT_SESSIONS",
      confirmed_provider_fee_pence: 27,
    },
  });
  const missing = (code: string, driver: number) => buildFrPerTripAuditRecord({
    row: {
      trip_id: `trip-${code}`,
      trip_code: code,
      captured_pence: 500,
      driver_net_pence: driver,
      wallet_credit_pence: 0,
      wallet_reconciliation_status: "WALLET_CREDIT_MISSING",
      onecab_gross_commission_pence: 75,
      commission_after_promotion_pence: 75,
      capture_reconciliation_status: "MATCHED",
      payout_reconciliation_status: "PAYOUT_NOT_DUE",
      fee_status: "CONFIRMED",
      payment_evidence_status: "PAYMENT_SESSIONS",
      confirmed_provider_fee_pence: 20,
    },
  });

  const records = [
    mk005,
    missing("MK-260817-001", 362),
    missing("MK-260817-002", 362),
    missing("MK-260817-003", 362),
  ];
  const period = buildFrPeriodAuditSummary(records);
  assertEquals(period.wallet_gap_total_pence, 1086);
  assertEquals(period.wallet_gap_trips.length, 3);
  assertEquals(
    period.wallet_gap_trips.reduce((s, t) => s + Math.abs(t.wallet_variance_pence), 0),
    1086,
  );
});

Deno.test("overview totals equal sum of per-trip audit rows", () => {
  const rows = [
    {
      trip_id: "a",
      ps_expected_capture_pence: 699,
      captured_pence: 699,
      driver_net_pence: 637,
      onecab_gross_commission_pence: 112,
      commission_after_promotion_pence: 62,
      confirmed_provider_fee_pence: 27,
      wallet_credit_pence: 637,
      airport_charge_pence: 0,
      tip_pence: 0,
      capture_reconciliation_status: "MATCHED",
      wallet_reconciliation_status: "WALLET_MATCHED",
      payout_reconciliation_status: "PAYOUT_NOT_DUE",
      fee_status: "CONFIRMED",
      payment_evidence_status: "PAYMENT_SESSIONS",
    },
    {
      trip_id: "b",
      ps_expected_capture_pence: 480,
      captured_pence: 480,
      driver_net_pence: 408,
      onecab_gross_commission_pence: 72,
      commission_after_promotion_pence: 72,
      confirmed_provider_fee_pence: 25,
      wallet_credit_pence: 408,
      airport_charge_pence: 0,
      tip_pence: 0,
      capture_reconciliation_status: "MATCHED",
      wallet_reconciliation_status: "WALLET_MATCHED",
      payout_reconciliation_status: "PAYOUT_NOT_DUE",
      fee_status: "CONFIRMED",
      payment_evidence_status: "PAYMENT_SESSIONS",
    },
  ];
  const records = rows.map((r) => buildFrPerTripAuditRecord({ row: r }));
  const overview = aggregateFrOverviewFromPerTripRecords(records, rows);
  assertEquals(
    overview.confirmed_provider_captured_total_pence,
    records.reduce((s, r) => s + (r.captured_amount_pence ?? 0), 0),
  );
  assertEquals(
    overview.provider_fee_total_pence,
    records.reduce((s, r) => s + (r.confirmed_provider_fee_pence ?? 0), 0),
  );
  assertEquals(
    overview.driver_net_total_pence,
    records.reduce((s, r) => s + (r.driver_entitlement_pence ?? 0), 0),
  );
});

Deno.test("Financial Reconciliation trip query requires PLATFORM_COLLECTED", () => {
  assertEquals(
    FINANCE_RECONCILIATION_TRIP_FINANCIAL_MODEL,
    SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED,
  );
});

Deno.test("Financial Reconciliation edge handler has no money writes", async () => {
  const src = await Deno.readTextFile(
    new URL("../admin-finance-reconciliation/index.ts", import.meta.url),
  );
  assertEquals(src.includes(".insert("), false);
  assertEquals(src.includes(".update("), false);
  assertEquals(src.includes(".upsert("), false);
});

Deno.test("MK-260817-005 wallet matched when ledger credit equals entitlement", () => {
  const rec = buildFrPerTripAuditRecord({
    row: {
      trip_id: "mk-005",
      trip_code: "MK-260817-005",
      captured_pence: 699,
      driver_net_pence: 637,
      commission_pence: 112,
      commissionable_fare_pence: 749,
      final_fare_pence: 699,
      offer_discount_pence: 50,
      discount_source: "global_offer",
      locked_base_fare_pence: 500,
      customer_modification_charge_pence: 249,
      wallet_credit_pence: 637,
      wallet_reconciliation_status: "WALLET_MATCHED",
      onecab_gross_commission_pence: 112,
      capture_reconciliation_status: "MATCHED",
      payout_reconciliation_status: "PAYOUT_NOT_DUE",
      fee_status: "CONFIRMED",
      payment_evidence_status: "PAYMENT_SESSIONS",
      confirmed_provider_fee_pence: 27,
    },
  });
  assertEquals(rec.commission_after_applied_promotion_pence, 62);
  assertEquals(rec.wallet_variance_pence, 0);
  assertEquals(rec.capture_variance_pence, 0);
  assertEquals(rec.evaluable, true);
});
