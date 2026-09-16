import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildHistoricalSettlementCorrectionPlan } from "./historicalSettlementCorrectionPlan.ts";

function mockSupabase(tripData: Record<string, unknown> | null) {
  return {
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: tripData }),
        }),
      }),
    }),
  };
}

Deno.test("settlement correction dry-run: MK-007 corrected plan returns 425p driver net", async () => {
  const result = await buildHistoricalSettlementCorrectionPlan(
    mockSupabase({
      id: "trip-007-uuid",
      trip_code: "MK-260817-007",
      capture_amount_pence: 480,
      settlement_formula_version: "2",
      commissionable_fare_pence: 480,
      commission_pence: 72,
      driver_net_pence: 408,
      accepted_commission_percent: 15,
      commission_pct: 15,
      final_fare_pence: 480,
      offer_discount_pence: 20,
      discount_source: "global_offer",
      locked_base_fare_pence: 500,
      fare_snapshot_json: { gross_fare_pence: 500, original_fare_pence: 500 },
      customer_modification_charge_pence: 0,
    }) as never,
    { tripId: "trip-007-uuid", allowedTripIds: ["trip-007-uuid"], dryRun: true },
  );
  assertEquals(result.status, "CORRECTION_REQUIRED_DRY_RUN");
  if (result.status === "CORRECTION_REQUIRED_DRY_RUN") {
    assertEquals(result.corrected.commissionable_fare_pence, 500);
    assertEquals(result.corrected.commission_pence, 75);
    assertEquals(result.corrected.driver_net_pence, 425);
    assertEquals(result.corrected.applied_customer_promotion_pence, 20);
    assertEquals(result.corrected.commission_after_promotion_pence, 55);
  }
});

Deno.test("settlement correction dry-run: MK-009 corrected plan returns 706p driver net", async () => {
  const result = await buildHistoricalSettlementCorrectionPlan(
    mockSupabase({
      id: "trip-009-uuid",
      trip_code: "MK-260817-009",
      capture_amount_pence: 798,
      settlement_formula_version: "2",
      commissionable_fare_pence: 798,
      commission_pence: 120,
      driver_net_pence: 678,
      accepted_commission_percent: 15,
      commission_pct: 15,
      final_fare_pence: 798,
      offer_discount_pence: 33,
      discount_source: "global_offer",
      locked_base_fare_pence: 831,
      fare_snapshot_json: { gross_fare_pence: 831, original_fare_pence: 831 },
      customer_modification_charge_pence: 0,
    }) as never,
    { tripId: "trip-009-uuid", allowedTripIds: ["trip-009-uuid"], dryRun: true },
  );
  assertEquals(result.status, "CORRECTION_REQUIRED_DRY_RUN");
  if (result.status === "CORRECTION_REQUIRED_DRY_RUN") {
    assertEquals(result.corrected.commissionable_fare_pence, 831);
    assertEquals(result.corrected.commission_pence, 125);
    assertEquals(result.corrected.driver_net_pence, 706);
    assertEquals(result.corrected.applied_customer_promotion_pence, 33);
    assertEquals(result.corrected.commission_after_promotion_pence, 92);
  }
});

Deno.test("settlement correction dry-run: MK-008 missing rate stays pending evidence", async () => {
  const result = await buildHistoricalSettlementCorrectionPlan(
    mockSupabase({
      id: "trip-008-uuid",
      trip_code: "MK-260817-008",
      capture_amount_pence: 716,
      commissionable_fare_pence: null,
      commission_pence: null,
      driver_net_pence: null,
      accepted_commission_percent: null,
      commission_pct: null,
      final_fare_pence: 716,
      offer_discount_pence: 29,
      discount_source: "global_offer",
      locked_base_fare_pence: 745,
      fare_snapshot_json: { gross_fare_pence: 745 },
      customer_modification_charge_pence: 0,
    }) as never,
    { tripId: "trip-008-uuid", allowedTripIds: ["trip-008-uuid"], dryRun: true },
  );
  assertEquals(result.status, "PENDING_EVIDENCE");
});
