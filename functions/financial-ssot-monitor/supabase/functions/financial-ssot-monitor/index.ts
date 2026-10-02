/**
 * Hourly financial SSOT monitor — detects fare mismatches across trip lifecycle.
 * Invoke via pg_cron or scheduled job: POST /functions/v1/financial-ssot-monitor
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";
import { resolveTripDisplayFare } from "../_shared/tripDisplayFareSSOT.ts";
import { calculateTripSettlementFromTripRow } from "../_shared/tripSettlement.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type TripRow = Record<string, unknown>;

function penceField(trip: TripRow, key: string): number {
  const n = Number(trip[key]);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function checkMismatch(
  trip: TripRow,
  stage: string,
  fieldName: string,
  actual: number,
  expected: number,
  mismatches: Array<Record<string, unknown>>,
): void {
  if (expected <= 0 || actual <= 0) return;
  if (actual === expected) return;
  mismatches.push({
    trip_id: trip.id,
    trip_code: trip.trip_code ?? null,
    stage,
    field_name: fieldName,
    expected_pence: expected,
    actual_pence: actual,
    details: { trip_status: trip.status },
  });
}

serveWithEdgeTiming("financial-ssot-monitor", async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data: trips, error } = await admin
    .from("trips")
    .select(
      "id, trip_code, status, payment_method, gross_fare_pence, offer_discount_pence, " +
        "voucher_discount_pence, discount_pence, discount_source, final_fare_pence, " +
        "final_customer_fare_pence, estimated_total_pence, fare, estimated_fare, " +
        "capture_amount_pence, commission_pence, driver_net_pence, fare_snapshot_json, " +
        "created_at",
    )
    .gte("created_at", since)
    .or("offer_discount_pence.gt.0,voucher_discount_pence.gt.0,discount_pence.gt.0");

  if (error) {
    console.error("[financial-ssot-monitor] query failed:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const mismatches: Array<Record<string, unknown>> = [];

  for (const trip of (trips ?? []) as TripRow[]) {
    const ssot = resolveTripDisplayFare(trip);
    const expected = penceField(trip, "final_customer_fare_pence") || ssot.payable_pence;
    if (expected <= 0) continue;

    checkMismatch(trip, "display_resolver", "resolveTripDisplayFare", ssot.payable_pence, expected, mismatches);
    checkMismatch(trip, "trip_row", "fare_column", Math.round(Number(trip.fare ?? 0) * 100), expected, mismatches);
    checkMismatch(trip, "trip_row", "estimated_fare_column", Math.round(Number(trip.estimated_fare ?? 0) * 100), expected, mismatches);
    checkMismatch(trip, "trip_row", "final_fare_pence", penceField(trip, "final_fare_pence"), expected, mismatches);
    checkMismatch(trip, "trip_row", "estimated_total_pence", penceField(trip, "estimated_total_pence"), expected, mismatches);

    const gross = penceField(trip, "gross_fare_pence");
    const discount = ssot.discount_pence;
    if (discount > 0 && gross > 0 && penceField(trip, "fare") === gross) {
      checkMismatch(trip, "gross_leak", "fare_equals_gross_with_discount", gross, expected, mismatches);
    }

    const settlement = calculateTripSettlementFromTripRow(trip);
    const expectedCommission = settlement?.commission_pence ?? 0;
    const storedCommission = penceField(trip, "commission_pence");
    if (storedCommission > 0 && Math.abs(storedCommission - expectedCommission) > 1) {
      checkMismatch(trip, "commission", "commission_pence", storedCommission, expectedCommission, mismatches);
    }
  }

  let inserted = 0;
  for (const row of mismatches) {
    const { error: upsertErr } = await admin.from("financial_ssot_mismatches").upsert(
      { ...row, detected_at: new Date().toISOString() },
      { onConflict: "trip_id,stage,field_name" },
    );
    if (!upsertErr) inserted++;
  }

  console.log(`[financial-ssot-monitor] scanned=${trips?.length ?? 0} mismatches=${mismatches.length} upserted=${inserted}`);

  return new Response(
    JSON.stringify({
      scanned: trips?.length ?? 0,
      mismatches_found: mismatches.length,
      upserted: inserted,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
