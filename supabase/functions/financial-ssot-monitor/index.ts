/**
 * Financial SSOT monitor — fare display mismatches + detect-only missing TEN.
 * Never inserts wallet money / never repairs / never calls provider or payout.
 *
 * Auth: Admin/staff JWT or service-role (requireAdminOrStaff).
 * Body:
 *   { dry_run: true, missing_ten_only?: true }
 *   { dry_run: false, mode: "detect_missing_ten", confirm_detect: "DETECT_MISSING_TEN_ONLY" }
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";
import { requireAdminOrStaff, corsHeaders as adminCors } from "../_shared/adminPaymentGate.ts";
import { resolveTripDisplayFare } from "../_shared/tripDisplayFareSSOT.ts";
import { calculateTripSettlementFromTripRow } from "../_shared/tripSettlement.ts";
import {
  detectMissingTripEarningNet,
  dryRunMatchesExpectedContract,
} from "../_shared/missingTripEarningNetDetectSSOT.ts";

const corsHeaders = {
  ...adminCors,
  "Content-Type": "application/json",
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

serveWithEdgeTiming("financial-ssot-monitor", corsHeaders, async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const gate = await requireAdminOrStaff(req);
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // Reject any repair / money flags hard.
  if (
    body.repair === true ||
    body.execute_repair === true ||
    body.credit === true ||
    body.insert_ten === true ||
    body.confirm_execute != null
  ) {
    return json({
      error: "REPAIR_FORBIDDEN",
      message: "financial-ssot-monitor is detect/audit only; repair flags are rejected",
    }, 400);
  }

  const dryRun = body.dry_run === true;
  const missingTenOnly = body.missing_ten_only === true ||
    body.mode === "detect_missing_ten" ||
    dryRun;
  const detectConfirm = body.confirm_detect === "DETECT_MISSING_TEN_ONLY";
  const detectMode = !dryRun && body.mode === "detect_missing_ten";

  if (detectMode && !detectConfirm) {
    return json({
      error: "CONFIRM_REQUIRED",
      message: 'detect mode requires confirm_detect:"DETECT_MISSING_TEN_ONLY"',
    }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Dry-run / detect branch before any fare-scan writes.
  if (dryRun) {
    const missingTen = await detectMissingTripEarningNet(admin, { dryRun: true });
    const contract = dryRunMatchesExpectedContract(missingTen.candidates);
    return json({
      dry_run: true,
      missing_ten_only: true,
      scanned: missingTen.scanned,
      candidates: missingTen.candidates,
      candidate_count: missingTen.candidates.length,
      informational_authoritative_total_pence: missingTen.informational_authoritative_total_pence,
      contract_match: contract.ok,
      contract_reason: contract.reason ?? null,
      upserted: 0,
      resolved: 0,
      fare_mismatches_upserted: 0,
      money_writes: false,
    });
  }

  if (detectMode) {
    const written = await detectMissingTripEarningNet(admin, { dryRun: false });
    const contract = dryRunMatchesExpectedContract(written.candidates);
    return json({
      dry_run: false,
      mode: "detect_missing_ten",
      scanned: written.scanned,
      candidates: written.candidates,
      candidate_count: written.candidates.length,
      informational_authoritative_total_pence: written.informational_authoritative_total_pence,
      upserted: written.upserted,
      resolved: written.resolved,
      contract_match: contract.ok,
      contract_reason: contract.reason ?? null,
      money_writes: false,
    });
  }

  // ── Legacy fare-display scan (audit only; skipped when missing_ten_only) ─
  if (missingTenOnly) {
    return json({
      dry_run: false,
      missing_ten_only: true,
      message: "missing_ten_only without detect confirm — no writes",
      upserted: 0,
      money_writes: false,
    });
  }

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
    return json({ error: error.message }, 500);
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

  // Also refresh missing-TEN detect (write) on full monitor runs.
  const writtenTen = await detectMissingTripEarningNet(admin, { dryRun: false });

  return json({
    scanned: trips?.length ?? 0,
    mismatches_found: mismatches.length,
    upserted: inserted,
    missing_ten_scanned: writtenTen.scanned,
    missing_ten_mismatches: writtenTen.upserted,
    money_writes: false,
  });
});
