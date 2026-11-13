/**
 * Lock: financial-ssot-monitor invariant scans (offer / airport / waiting / assignment).
 *
 * The monitor must keep scanning these stages into the EXISTING
 * financial_ssot_mismatches table (onConflict trip_id,stage,field_name), log ONE
 * structured line per NEW mismatch (ids only, no PII), and use no Slack/PagerDuty.
 *
 * Run: deno test --no-check --allow-read supabase/tests/_shared/financialSsotMonitorScansLock.test.ts
 * If this fails, fix the code — never delete or soften the lock.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateInvalidAssignmentOwnership,
  evaluateOfferInvariants,
  evaluateOverlappingWaitingOpen,
} from "../../functions/_shared/financialSsotMonitorScans.ts";

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));
const MONITOR = "../../functions/financial-ssot-monitor/index.ts";
const SCANS = "../../functions/_shared/financialSsotMonitorScans.ts";

const STAGES = [
  "offer_vs_committed",
  "airport_component_missing",
  "driver_net_vs_breakdown",
  "overlapping_waiting_open",
  "invalid_assignment_ownership",
] as const;

Deno.test("monitor source includes every invariant stage string", async () => {
  const monitor = await read(MONITOR);
  const scans = await read(SCANS);
  for (const stage of STAGES) {
    assertStringIncludes(monitor, `"${stage}"`, `monitor index.ts must list stage ${stage}`);
    assertStringIncludes(scans, `"${stage}"`, `scans module must emit stage ${stage}`);
  }
});

Deno.test("monitor keeps existing table + onConflict dedupe, 48h window, one log line per NEW row", async () => {
  const src = await read(MONITOR);
  assertStringIncludes(src, "48 * 60 * 60 * 1000");
  assertStringIncludes(src, '"financial_ssot_mismatches"');
  assertStringIncludes(src, 'onConflict: "trip_id,stage,field_name"');
  assertStringIncludes(src, "financial_ssot_invariant_mismatch");
  assertStringIncludes(src, "existing.has(");
  // scans read the sources named in the spec
  assertStringIncludes(src, '.from("ride_offers")');
  assertStringIncludes(src, '.in("status", ["pending", "accepted"])');
  assertStringIncludes(src, '.from("trip_waiting_segments")');
  assertStringIncludes(src, '.is("ended_at", null)');
  assertStringIncludes(src, "confirmed_driver_id");
  // each scan isolated, never blocks the fare scan
  assertStringIncludes(src, "invariant scan failed");
});

Deno.test("monitor: no Slack / PagerDuty / external alerting, no PII in the structured line", async () => {
  const src = (await read(MONITOR)) + (await read(SCANS));
  assert(!/slack|pagerduty|hooks\.slack|events\.pagerduty|fetch\(/i.test(src), "console + table only");
  const m = /console\.warn\(JSON\.stringify\(\{([\s\S]*?)\}\)\)/.exec(src);
  assert(m, "structured log line must exist");
  const keys = [...m[1].matchAll(/^\s*(\w+):/gm)].map((x) => x[1]).sort();
  assertEquals(keys, ["event", "field", "stage", "trip_id"], "log = stage + field + trip_id only (no PII)");
});

Deno.test("scans reuse the existing SSOTs (no new fare maths)", async () => {
  const scans = await read(SCANS);
  assertStringIncludes(scans, 'from "./committedBookingOfferFareSSOT.ts"');
  assertStringIncludes(scans, 'from "./airportChargeFareSplitSSOT.ts"');
  assertStringIncludes(scans, "resolveCommittedOfferGross");
  assertStringIncludes(scans, "stampOfferDriverNetFromCommittedFare");
  assertStringIncludes(scans, "driverNetFromCustomerTotal");
  assert(!/\.(insert|update|delete|upsert|rpc)\(/.test(scans), "scan module is read-only evaluators");
});

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------
const committed480 = {
  id: "t1",
  trip_code: "MK-TEST-001",
  status: "searching",
  locked_base_fare_pence: 480,
  final_customer_fare_pence: 480,
  estimated_total_pence: 480,
};

Deno.test("offer_vs_committed: stale base 500 beside committed 480 (MK-004/005)", () => {
  const rows = evaluateOfferInvariants(committed480, [{
    id: "o1",
    trip_id: "t1",
    status: "pending",
    effective_commission_percent: 10,
    offered_driver_net_pence: 450,
    offer_snapshot: { baseFarePence: 500 },
  }]);
  const base = rows.find((r) => r.field_name === "base_fare_pence");
  assertEquals(base?.stage, "offer_vs_committed");
  assertEquals([base?.expected_pence, base?.actual_pence], [480, 500]);
  const net = rows.find((r) => r.field_name === "driver_net_pence");
  assertEquals([net?.expected_pence, net?.actual_pence], [432, 450]);
});

Deno.test("offer_vs_committed: consistent offer and +/-1p tolerance produce nothing", () => {
  assertEquals(
    evaluateOfferInvariants(committed480, [{
      id: "o1", trip_id: "t1", status: "pending", effective_commission_percent: 10,
      offered_driver_net_pence: 433, offer_snapshot: { baseFarePence: 481 },
    }]),
    [],
  );
});

Deno.test("offer_vs_committed: breakdown-only / closed ignored; stacked pending is scanned", () => {
  const offer = {
    id: "o1", trip_id: "t1", status: "pending", effective_commission_percent: 10,
    offered_driver_net_pence: 1, offer_snapshot: { baseFarePence: 999 },
  };
  assertEquals(
    evaluateOfferInvariants({ id: "t1", fare_breakdown: { final_fare_pence: 500 } }, [offer])
      .filter((r) => r.stage === "offer_vs_committed"),
    [],
  );
  assertEquals(evaluateOfferInvariants(committed480, [{ ...offer, status: "expired" }]), []);
  const stacked = evaluateOfferInvariants(committed480, [{ ...offer, is_stacked: true }]);
  assertEquals(stacked.some((r) => r.stage === "offer_vs_committed"), true);
});

Deno.test("airport_component_missing + driver_net_vs_breakdown: MK-007 Heathrow shape", () => {
  const trip = { ...committed480, locked_base_fare_pence: 7300, final_customer_fare_pence: 7300, estimated_total_pence: 7300, airport_charge_pence: 700 };
  // Offer net ignored the airport: 7300 x 0.9 = 6570 instead of 5940 + 700 = 6640.
  const rows = evaluateOfferInvariants(trip, [{
    id: "o1", trip_id: "t1", status: "pending", effective_commission_percent: 10,
    offered_driver_net_pence: 6570, offer_snapshot: { baseFarePence: 7300 },
  }]);
  const missing = rows.find((r) => r.stage === "airport_component_missing");
  assertEquals([missing?.expected_pence, missing?.actual_pence], [700, 0]);
  const net = rows.find((r) => r.stage === "driver_net_vs_breakdown");
  assertEquals([net?.expected_pence, net?.actual_pence], [6640, 6570]);
});

Deno.test("airport present in snapshot + correct net: no airport / net mismatch", () => {
  const trip = { ...committed480, locked_base_fare_pence: 7300, final_customer_fare_pence: 7300, estimated_total_pence: 7300, airport_charge_pence: 700 };
  assertEquals(
    evaluateOfferInvariants(trip, [{
      id: "o1", trip_id: "t1", status: "pending", effective_commission_percent: 10,
      offered_driver_net_pence: 6640,
      offer_snapshot: { baseFarePence: 7300, airport_charge_pence: 700, airport_charge_state: "present" },
    }]),
    [],
  );
});

Deno.test("overlapping_waiting_open: >1 open per session flagged; pickup and stop sessions are separate", () => {
  const rows = evaluateOverlappingWaitingOpen([
    { trip_id: "t1", location_type: "pickup", ended_at: null },
    { trip_id: "t1", location_type: "pickup", ended_at: null },
    { trip_id: "t1", location_type: "stop", stop_id: "s1", ended_at: null },
    { trip_id: "t2", location_type: "pickup", ended_at: null },
    { trip_id: "t2", location_type: "stop", stop_id: "s1", ended_at: null },
    { trip_id: "t3", location_type: "pickup", ended_at: "2026-11-13T10:00:00Z" },
    { trip_id: "t3", location_type: "pickup", ended_at: "2026-11-13T10:05:00Z" },
  ]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].stage, "overlapping_waiting_open");
  assertEquals(rows[0].trip_id, "t1");
  assertEquals(rows[0].actual_pence, 2);
});

Deno.test("invalid_assignment_ownership: confirmed_driver_id IS DISTINCT FROM driver_id on live statuses only", () => {
  const rows = evaluateInvalidAssignmentOwnership([
    { id: "a", status: "assigned", driver_id: "d1", confirmed_driver_id: "d2" },
    { id: "b", status: "in_progress", driver_id: null, confirmed_driver_id: "d2" },
    { id: "c", status: "en_route", driver_id: "d1", confirmed_driver_id: "d1" },
    { id: "d", status: "arrived", driver_id: null, confirmed_driver_id: null },
    { id: "e", status: "completed", driver_id: "d1", confirmed_driver_id: "d2" },
    { id: "f", status: "searching", driver_id: null, confirmed_driver_id: "d2" },
  ]);
  assertEquals(rows.map((r) => r.trip_id).sort(), ["a", "b"]);
  assertEquals(rows[0].stage, "invalid_assignment_ownership");
});
