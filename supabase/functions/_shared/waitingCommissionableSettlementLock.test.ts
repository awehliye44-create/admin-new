/**
 * Waiting is COMMISSIONABLE — settlement stamp must include pickup + stop waiting.
 *
 * Fixtures:
 *   MK-260708-008 — golden: ride 680 + wait 18 → commissionable 698 / net 593
 *   MK-260815-028 — ride 788 + wait 12 → commissionable 800 / commission 120 / net 680
 *
 * Drift lock: ride-only stamps (commissionable === final_customer while waiting > 0)
 * must not be treated as canonical once final/captured includes waiting.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calculateCanonicalSettlement,
  commissionableFromComponents,
  CANONICAL_SETTLEMENT_GOLDEN_TRIPS,
} from "../../../shared/canonicalSettlementSSOT.ts";
import {
  buildSettlementTripRow,
  calculateTripSettlement,
  calculateTripSettlementFromTripRow,
  resolveCapturedTripEarningNetPence,
  tripSettlementDbColumns,
} from "./tripSettlement.ts";
import { resolveTripFare } from "./tripFareSSOT.ts";
import {
  evaluateLedgerEntryEligibility,
  PAYOUT_ELIGIBILITY_STATUS,
} from "./driverPayoutEligibilitySSOT.ts";

const MK008 = CANONICAL_SETTLEMENT_GOLDEN_TRIPS.find((t) => t.trip_code === "MK-260708-008")!;

Deno.test("1. pickup waiting included in commissionable", () => {
  const commissionable = commissionableFromComponents({
    ride_fare_pence: 788,
    pickup_waiting_charge_pence: 12,
  });
  assertEquals(commissionable, 800);
  const s = calculateTripSettlement({
    final_fare_pence: 800,
    driver_tier_commission_percent: 15,
  });
  assertEquals(s.commissionable_fare_pence, 800);
  assertEquals(s.commission_pence, 120);
  assertEquals(s.driver_net_pence, 680);
});

Deno.test("2. stop waiting included in commissionable", () => {
  const commissionable = commissionableFromComponents({
    ride_fare_pence: 500,
    stop_waiting_charge_pence: 61,
  });
  assertEquals(commissionable, 561);
  const s = calculateTripSettlement({
    final_fare_pence: 561,
    driver_tier_commission_percent: 15,
  });
  assertEquals(s.commissionable_fare_pence, 561);
  assertEquals(s.commission_pence, 84);
  assertEquals(s.driver_net_pence, 477);
});

Deno.test("3. pickup + stop waiting together", () => {
  const commissionable = commissionableFromComponents({
    ride_fare_pence: 700,
    pickup_waiting_charge_pence: 18,
    stop_waiting_charge_pence: 12,
  });
  assertEquals(commissionable, 730);
  const s = calculateTripSettlement({
    final_fare_pence: 730,
    driver_tier_commission_percent: 15,
  });
  assertEquals(s.commissionable_fare_pence, 730);
  assertEquals(s.commission_pence, 110);
  assertEquals(s.driver_net_pence, 620);
});

Deno.test("4. airport excluded from commissionable", () => {
  const s = calculateTripSettlement({
    final_fare_pence: 800 + 500,
    airport_charge_pence: 500,
    driver_tier_commission_percent: 15,
  });
  assertEquals(s.commissionable_fare_pence, 800);
  assertEquals(s.commission_pence, 120);
  assertEquals(s.driver_net_pence, 680);
  assertEquals(s.driver_total_earnings_pence, 680 + 500);
});

Deno.test("5. tip excluded from commissionable and credited separately", () => {
  const s = calculateTripSettlement({
    final_fare_pence: 800,
    tips_pence: 200,
    driver_tier_commission_percent: 15,
  });
  assertEquals(s.commissionable_fare_pence, 800);
  assertEquals(s.commission_pence, 120);
  assertEquals(s.driver_net_pence, 680);
  assertEquals(s.driver_total_earnings_pence, 880);
  const wallet = resolveCapturedTripEarningNetPence({
    trip: {
      final_fare_pence: 800,
      pickup_waiting_charge_pence: 12,
      final_customer_fare_pence: 788,
      accepted_commission_percent: 15,
      tip_pence: 200,
    },
    captureAmountPence: 1000,
    tipPence: 200,
  });
  // Wallet TRIP_EARNING_NET excludes tip (tip on DRIVER_TIP_CREDIT).
  assertEquals(wallet.driverNetPence, 680);
  assertEquals(wallet.tipPence, 200);
});

Deno.test("6. discount + waiting — final_customer is net ride; waiting still commissionable", () => {
  const fare = resolveTripFare({
    final_customer_fare_pence: 788,
    fare_locked: true,
    pickup_waiting_charge_pence: 12,
    discount_pence: 50,
    gross_fare_pence: 838,
  });
  assertEquals(fare.final_fare_pence, 800);
  const s = calculateTripSettlement({
    final_fare_pence: fare.final_fare_pence,
    driver_tier_commission_percent: 15,
  });
  assertEquals(s.commissionable_fare_pence, 800);
  assertEquals(s.driver_net_pence, 680);
});

Deno.test("7. accepted commission different from default", () => {
  const s = calculateTripSettlement({
    final_fare_pence: 800,
    driver_tier_commission_percent: 10,
  });
  assertEquals(s.commissionable_fare_pence, 800);
  assertEquals(s.commission_pence, 80);
  assertEquals(s.driver_net_pence, 720);
});

Deno.test("8. final trip stamp matches canonical settlement (MK-260815-028)", () => {
  const components = calculateCanonicalSettlement({
    ride_fare_pence: 788,
    pickup_waiting_charge_pence: 12,
    stop_waiting_charge_pence: 0,
    commission_percent: 15,
  });
  assertEquals(components.commissionable_fare_pence, 800);
  assertEquals(components.onecab_gross_commission_pence, 120);
  assertEquals(components.driver_net_pence, 680);

  const row = buildSettlementTripRow({
    trip: {
      final_customer_fare_pence: 788,
      final_fare_pence: 800,
      pickup_waiting_charge_pence: 12,
      stop_waiting_charge_pence: 0,
      accepted_commission_percent: 15,
    },
    finalFarePence: 800,
    captureAmountPence: 800,
    pickupWaitingChargePence: 12,
    stopWaitingChargePence: 0,
  });
  const settlement = calculateTripSettlementFromTripRow(row)!;
  const stamp = tripSettlementDbColumns(settlement);
  assertEquals(stamp.commissionable_fare_pence, 800);
  assertEquals(stamp.commission_pence, 120);
  assertEquals(stamp.driver_net_pence, 680);
  assertEquals(stamp.final_fare_pence, 800);
});

Deno.test("9. wallet earning matches stamped canonical driver net (MK-260815-028)", () => {
  const wallet = resolveCapturedTripEarningNetPence({
    trip: {
      final_customer_fare_pence: 788,
      final_fare_pence: 800,
      pickup_waiting_charge_pence: 12,
      accepted_commission_percent: 15,
      // Stale ride-only stamp must not poison wallet when capture/final include waiting.
      commissionable_fare_pence: 788,
      commission_pence: 118,
      driver_net_pence: 670,
    },
    captureAmountPence: 800,
  });
  assertEquals(wallet.driverNetPence, 680);
  assertEquals(wallet.settlement?.commissionable_fare_pence, 800);
  assertEquals(wallet.settlement?.commission_pence, 120);
  assertEquals(wallet.settlement?.driver_net_pence, 680);
});

Deno.test("10. no WALLET_CREDIT_MISMATCH for valid waiting trips after stamp aligns", () => {
  const aligned = evaluateLedgerEntryEligibility(
    {
      ledger_entry_id: "ledger-028",
      trip_id: "trip-028",
      ledger_type: "TRIP_EARNING_NET",
      amount_pence: 680,
      trip_exists: true,
      payment_session_id: "ps-028",
      captured_amount_pence: 800,
      canonical_driver_net_pence: 680,
      fr_trip_status: "BALANCED",
      refunded_amount_pence: 0,
      captured_at: "2020-01-01T00:00:00.000Z",
      earning_credited_at: "2020-01-01T00:00:00.000Z",
      provider_available_on: "2020-01-01T00:00:00.000Z",
      payment_collection_model: "PLATFORM_COLLECTED",
      trip_status: "completed",
      completed_at: "2020-01-01T00:00:00.000Z",
    },
  );
  assertEquals(aligned.status, PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE);

  const mismatch = evaluateLedgerEntryEligibility(
    {
      ledger_entry_id: "ledger-028-drift",
      trip_id: "trip-028",
      ledger_type: "TRIP_EARNING_NET",
      amount_pence: 680,
      trip_exists: true,
      payment_session_id: "ps-028",
      captured_amount_pence: 800,
      // Stale ride-only stamp still causes mismatch — this is the drift we repair.
      canonical_driver_net_pence: 670,
      fr_trip_status: "BALANCED",
      refunded_amount_pence: 0,
      captured_at: "2020-01-01T00:00:00.000Z",
      earning_credited_at: "2020-01-01T00:00:00.000Z",
      provider_available_on: "2020-01-01T00:00:00.000Z",
      payment_collection_model: "PLATFORM_COLLECTED",
      trip_status: "completed",
      completed_at: "2020-01-01T00:00:00.000Z",
    },
  );
  assertEquals(mismatch.status, PAYOUT_ELIGIBILITY_STATUS.WALLET_CREDIT_MISMATCH);
});

Deno.test("MK-260708-008 golden — waiting inside commissionable", () => {
  const s = calculateCanonicalSettlement({
    ride_fare_pence: MK008.ride_fare_pence,
    pickup_waiting_charge_pence: MK008.pickup_waiting_charge_pence,
    stop_waiting_charge_pence: MK008.stop_waiting_charge_pence,
    airport_charge_pence: MK008.airport_charge_pence,
    tip_pence: MK008.tip_pence,
    commission_percent: MK008.commission_percent,
    provider_processing_fee_pence: MK008.provider_processing_fee_pence,
    fee_confirmed: true,
  });
  assertEquals(s.commissionable_fare_pence, MK008.expected.commissionable_fare_pence);
  assertEquals(s.onecab_gross_commission_pence, MK008.expected.onecab_gross_commission_pence);
  assertEquals(s.driver_net_pence, MK008.expected.driver_net_pence);
});

Deno.test("ride-only stamp must not win over customer+waiting when resolving settlement fare", () => {
  const settlement = calculateTripSettlementFromTripRow({
    final_customer_fare_pence: 788,
    final_fare_pence: 788, // stale ride-only final
    capture_amount_pence: 800,
    pickup_waiting_charge_pence: 12,
    accepted_commission_percent: 15,
    commissionable_fare_pence: 788,
    driver_net_pence: 670,
  })!;
  assertEquals(settlement.commissionable_fare_pence, 800);
  assertEquals(settlement.driver_net_pence, 680);
});
