/**
 * Lock: debt recovered on a later booking never enters that trip's driver
 * earnings or ONECAB commissionable fare — including every path that
 * recomputes settlement from the trip row.
 *
 * MK-260925-003: captured 740 = trip fare 704 + recovered debt 36.
 * Settlement must be 704 → commission 106 → driver 598, never 740-based.
 */
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  calculateTripSettlementFromTripRow,
  recoveredDebtTripFareComponentPence,
  type TripSettlementTripRow,
} from "./tripSettlement.ts";
import {
  loadRecoveredDebtFareComponents,
  withRecoveredDebtFareComponent,
} from "./recoveredDebtFareComponents.ts";
import {
  computeExpectedStampForRepair,
  DRIVER_FINANCIAL_REPAIR_BLOCK,
  type DriverFinancialRepairEvidence,
} from "./driverFinancialReviewRepairSSOT.ts";

const TRIP = "22222222-2222-2222-2222-222222222222";

const recoveryTripRow = {
  id: TRIP,
  final_fare_pence: 740,
  capture_amount_pence: 740,
  tip_pence: 0,
  airport_charge_pence: 0,
  accepted_commission_percent: 15,
  commission_pct: 15,
  driver_tier_commission_percent: 15,
};

function fakeSessions(rows: Array<Record<string, unknown>>, error: { message: string } | null = null) {
  const builder = {
    select: () => builder,
    in: () => builder,
    gt: () => Promise.resolve({ data: error ? null : rows, error }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

Deno.test("recoveredDebtTripFareComponentPence: only set when debt was folded into the capture", () => {
  assertEquals(recoveredDebtTripFareComponentPence({ trip_fare_component_pence: 704, receivable_component_pence: 36 }), 704);
  assertEquals(recoveredDebtTripFareComponentPence({ trip_fare_component_pence: 704, receivable_component_pence: 0 }), null);
  assertEquals(recoveredDebtTripFareComponentPence(null), null);
  assert(Number.isNaN(recoveredDebtTripFareComponentPence({ trip_fare_component_pence: null, receivable_component_pence: 36 })));
});

Deno.test("trip-row recompute without the component would pay recovered debt to the driver", () => {
  const naive = calculateTripSettlementFromTripRow(recoveryTripRow as TripSettlementTripRow);
  assert(naive);
  assertEquals(naive.commissionable_fare_pence, 740);
});

Deno.test("trip-row recompute with the frozen component excludes recovered debt (704 / 106 / 598)", async () => {
  const components = await loadRecoveredDebtFareComponents(
    fakeSessions([{ trip_id: TRIP, trip_fare_component_pence: 704, receivable_component_pence: 36 }]),
    [TRIP],
  );
  const s = calculateTripSettlementFromTripRow(
    withRecoveredDebtFareComponent(recoveryTripRow, components) as TripSettlementTripRow,
  );
  assert(s);
  assertEquals(s.commissionable_fare_pence, 704);
  assertEquals(s.commission_pence, 106);
  assertEquals(s.driver_total_earnings_pence, 598);
});

Deno.test("trips without folded debt are untouched", async () => {
  const components = await loadRecoveredDebtFareComponents(fakeSessions([]), [TRIP]);
  assertEquals(withRecoveredDebtFareComponent(recoveryTripRow, components), recoveryTripRow);
});

Deno.test("loader fails closed on read error and flags ambiguous sessions", async () => {
  await assertRejects(() => loadRecoveredDebtFareComponents(fakeSessions([], { message: "timeout" }), [TRIP]));
  const c = await loadRecoveredDebtFareComponents(
    fakeSessions([{ trip_id: TRIP, trip_fare_component_pence: null, receivable_component_pence: 36 }]),
    [TRIP],
  );
  assert(c.ambiguousTripIds.has(TRIP));
  assertEquals(c.fareByTrip.size, 0);
});

function repairEvidence(overrides: Partial<DriverFinancialRepairEvidence> = {}): DriverFinancialRepairEvidence {
  return {
    driver_id: "drv-1",
    driver_name: "Driver",
    driver_code: "MK0006",
    trip_id: TRIP,
    trip_code: "MK-260925-003",
    trip_status: "completed",
    financial_model: "PLATFORM_COLLECTED",
    financial_outcome: null,
    payment_session_id: "ps-1",
    payment_session_lineage_ok: true,
    provider_order_id: "ord-1",
    provider_payment_id: "pay-1",
    provider_state: "COMPLETED",
    captured_amount_pence: 740,
    trip_fare_component_pence: 704,
    receivable_component_pence: 36,
    final_fare_pence: 740,
    commission_basis_pence: 740,
    commission_rate_percent: 15,
    commission_rule_source: "ride_offers.effective_commission_percent",
    commission_pence: 106,
    provider_fee_pence: 0,
    provider_processing_fee_pence: 0,
    provider_fee_status: "ACTUAL",
    tip_pence: 0,
    airport_charge_pence: 0,
    existing_driver_net_pence: 598,
    existing_commission_pence: 106,
    existing_tip_pence: 0,
    actual_ten_credit_pence: 598,
    actual_tip_credit_pence: 0,
    currency: "GBP",
    expected_currency: "GBP",
    has_contradictory_stamps: false,
    active_payout_reservation: false,
    payout_intent_status: null,
    ...overrides,
  } as DriverFinancialRepairEvidence;
}

Deno.test("driver financial repair: expected stamp excludes recovered debt", () => {
  const r = computeExpectedStampForRepair(repairEvidence());
  assert(r.ok);
  assertEquals(r.settlement.commissionable_fare_pence, 704);
  assertEquals(r.settlement.commission_pence, 106);
  assertEquals(r.expected_credit_pence, 598);
});

Deno.test("driver financial repair: debt folded in but no fare component → blocked, never guessed", () => {
  const r = computeExpectedStampForRepair(repairEvidence({ trip_fare_component_pence: null }));
  assert(!r.ok);
  assertEquals(r.block_code, DRIVER_FINANCIAL_REPAIR_BLOCK.AMBIGUOUS_ENTITLEMENT);
});

Deno.test("driver financial repair: terminal outcome capture that included debt → blocked", () => {
  const r = computeExpectedStampForRepair(repairEvidence({ financial_outcome: "NO_SHOW", trip_status: "no_show" }));
  assert(!r.ok);
  assertEquals(r.block_code, DRIVER_FINANCIAL_REPAIR_BLOCK.AMBIGUOUS_ENTITLEMENT);
});
