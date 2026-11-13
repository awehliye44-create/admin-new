/**
 * Hourly financial SSOT monitor — detects fare mismatches across trip lifecycle.
 * Invoke via pg_cron or scheduled job: POST /functions/v1/financial-ssot-monitor
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";
import { resolveTripDisplayFare } from "../_shared/tripDisplayFareSSOT.ts";
import { calculateTripSettlementFromTripRow } from "../_shared/tripSettlement.ts";
import {
  loadRecoveredDebtFareComponents,
  type RecoveredDebtFareComponents,
  withRecoveredDebtFareComponent,
} from "../_shared/recoveredDebtFareComponents.ts";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import {
  evaluateInvalidAssignmentOwnership,
  evaluateOfferInvariants,
  evaluateOverlappingWaitingOpen,
  MONITOR_ASSIGNMENT_STATUSES,
  type MonitorMismatchRow,
  type MonitorOfferRow,
  type MonitorTripRow,
} from "../_shared/financialSsotMonitorScans.ts";

/**
 * Invariant scans added on top of the fare scans (same table, same onConflict).
 * Lock: supabase/tests/_shared/financialSsotMonitorScansLock.test.ts
 */
const INVARIANT_SCAN_STAGES = [
  "offer_vs_committed",
  "airport_component_missing",
  "driver_net_vs_breakdown",
  "overlapping_waiting_open",
  "invalid_assignment_ownership",
] as const;

const OFFER_TRIP_SELECT =
  "id, trip_code, status, locked_base_fare_pence, final_customer_fare_pence, final_fare_pence, " +
  "estimated_total_pence, gross_fare_pence, authorised_amount_pence, estimated_fare, fare, " +
  "customer_modification_charge_pence, airport_charge_pence, other_pass_through_charges_pence, " +
  "offer_discount_pence, voucher_discount_pence, discount_pence, discount_source, " +
  "fare_snapshot_json, fare_breakdown";

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// deno-lint-ignore no-explicit-any
async function scanOfferInvariants(admin: any, since: string): Promise<MonitorMismatchRow[]> {
  const { data: offers, error } = await admin
    .from("ride_offers")
    .select(
      "id, trip_id, status, is_stacked, created_at, effective_commission_percent, " +
        "offered_driver_net_pence, offer_snapshot",
    )
    .in("status", ["pending", "accepted"])
    .gte("created_at", since)
    .limit(5000);
  if (error) throw new Error(`ride_offers: ${error.message}`);

  const byTrip = new Map<string, MonitorOfferRow[]>();
  for (const o of (offers ?? []) as MonitorOfferRow[]) {
    if (!o.trip_id) continue;
    const list = byTrip.get(o.trip_id) ?? [];
    list.push(o);
    byTrip.set(o.trip_id, list);
  }

  const rows: MonitorMismatchRow[] = [];
  for (const ids of chunk([...byTrip.keys()], 100)) {
    const { data: trips, error: tripErr } = await admin
      .from("trips")
      .select(OFFER_TRIP_SELECT)
      .in("id", ids);
    if (tripErr) throw new Error(`trips(offers): ${tripErr.message}`);
    for (const trip of (trips ?? []) as MonitorTripRow[]) {
      rows.push(...evaluateOfferInvariants(trip, byTrip.get(String(trip.id)) ?? []));
    }
  }
  return rows;
}

// deno-lint-ignore no-explicit-any
async function scanOverlappingWaitingOpen(admin: any, since: string): Promise<MonitorMismatchRow[]> {
  const { data, error } = await admin
    .from("trip_waiting_segments")
    .select("trip_id, location_type, stop_id, ended_at")
    .is("ended_at", null)
    .gte("started_at", since)
    .limit(5000);
  if (error) throw new Error(`trip_waiting_segments: ${error.message}`);
  return evaluateOverlappingWaitingOpen(data ?? []);
}

// deno-lint-ignore no-explicit-any
async function scanInvalidAssignmentOwnership(admin: any, since: string): Promise<MonitorMismatchRow[]> {
  const { data, error } = await admin
    .from("trips")
    .select("id, trip_code, status, driver_id, confirmed_driver_id")
    .in("status", [...MONITOR_ASSIGNMENT_STATUSES])
    .gte("updated_at", since)
    .limit(5000);
  if (error) throw new Error(`trips(assignment): ${error.message}`);
  return evaluateInvalidAssignmentOwnership(data ?? []);
}

/** Keys (trip|stage|field) already present, so only NEW rows are logged. */
async function loadExistingInvariantKeys(
  // deno-lint-ignore no-explicit-any
  admin: any,
  rows: MonitorMismatchRow[],
): Promise<Set<string>> {
  const keys = new Set<string>();
  const tripIds = [...new Set(rows.map((r) => r.trip_id))];
  for (const ids of chunk(tripIds, 100)) {
    const { data, error } = await admin
      .from("financial_ssot_mismatches")
      .select("trip_id, stage, field_name")
      .in("trip_id", ids)
      .in("stage", [...INVARIANT_SCAN_STAGES]);
    if (error) {
      console.error("[financial-ssot-monitor] existing invariant lookup failed:", error.message);
      continue;
    }
    for (const r of data ?? []) keys.add(`${r.trip_id}|${r.stage}|${r.field_name}`);
  }
  return keys;
}

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
  const cronAuth = await assertCronOrServiceRoleAuth(req);
  if (!cronAuth.ok) return cronAuth.response;

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

  let debtFare: RecoveredDebtFareComponents = { fareByTrip: new Map(), ambiguousTripIds: new Set() };
  try {
    debtFare = await loadRecoveredDebtFareComponents(
      admin,
      ((trips ?? []) as unknown as TripRow[]).map((t) => String(t.id ?? "")),
    );
  } catch (err) {
    console.error("[financial-ssot-monitor] recovered debt fare components unavailable:", err);
  }

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

    if (debtFare.ambiguousTripIds.has(String(trip.id ?? ""))) {
      mismatches.push({
        trip_id: trip.id,
        trip_code: trip.trip_code ?? null,
        stage: "recovered_debt",
        field_name: "trip_fare_component_pence",
        expected_pence: 1,
        actual_pence: Math.max(2, penceField(trip, "capture_amount_pence")),
        details: {
          trip_status: trip.status,
          reason: "Capture included customer debt but the trip fare component is missing",
        },
      });
      continue;
    }
    const settlement = calculateTripSettlementFromTripRow(
      withRecoveredDebtFareComponent(trip as Record<string, unknown>, debtFare) as TripRow,
    );
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

  // Invariant scans (offer / airport / waiting / assignment). Each scan is isolated:
  // one failing query never blocks the others or the fare scan above.
  const invariantRows: MonitorMismatchRow[] = [];
  const scanFailures: string[] = [];
  const invariantScans: Array<[string, () => Promise<MonitorMismatchRow[]>]> = [
    ["offers", () => scanOfferInvariants(admin, since)],
    ["waiting", () => scanOverlappingWaitingOpen(admin, since)],
    ["assignment", () => scanInvalidAssignmentOwnership(admin, since)],
  ];
  for (const [name, run] of invariantScans) {
    try {
      invariantRows.push(...await run());
    } catch (err) {
      scanFailures.push(name);
      console.error(`[financial-ssot-monitor] invariant scan failed scan=${name}:`, (err as Error).message);
    }
  }

  let invariantNew = 0;
  let invariantUpserted = 0;
  if (invariantRows.length > 0) {
    const existing = await loadExistingInvariantKeys(admin, invariantRows);
    for (const r of invariantRows) {
      const { error: upsertErr } = await admin.from("financial_ssot_mismatches").upsert(
        { ...r, detected_at: new Date().toISOString() },
        { onConflict: "trip_id,stage,field_name" },
      );
      if (upsertErr) continue;
      invariantUpserted++;
      if (!existing.has(`${r.trip_id}|${r.stage}|${r.field_name}`)) {
        invariantNew++;
        // ONE structured line per NEW mismatch. Ids only — no PII, no payload.
        console.warn(JSON.stringify({
          event: "financial_ssot_invariant_mismatch",
          stage: r.stage,
          field: r.field_name,
          trip_id: r.trip_id,
        }));
      }
    }
  }

  console.log(
    `[financial-ssot-monitor] scanned=${trips?.length ?? 0} mismatches=${mismatches.length} upserted=${inserted} ` +
      `invariant_found=${invariantRows.length} invariant_new=${invariantNew} invariant_upserted=${invariantUpserted} ` +
      `invariant_scan_failures=${scanFailures.length}`,
  );

  return new Response(
    JSON.stringify({
      scanned: trips?.length ?? 0,
      mismatches_found: mismatches.length,
      upserted: inserted,
      invariant_mismatches_found: invariantRows.length,
      invariant_mismatches_new: invariantNew,
      invariant_scan_failures: scanFailures,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
