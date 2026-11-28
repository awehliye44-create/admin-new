/**
 * LOCK — vehicle replacement lifecycle SSOT.
 *
 * Root cause this migration locks against:
 *  1) Approving a vehicle change must not rewrite the previous vehicles row identity
 *     (make/model/year/color/plate stay on the old id for Admin history).
 *  2) Vehicle-scoped documents must carry vehicle_id; supersession is per-vehicle
 *     so replacement uploads never overwrite the previous vehicle's approved docs.
 *
 * Run: deno test --allow-read supabase/tests/_shared/vehicleReplacementLifecycleLock.test.ts
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20270305100000_vehicle_replacement_lifecycle_ssot.sql",
  import.meta.url,
);
const LEGACY_MIGRATION = new URL(
  "../../migrations/20261214120000_driver_vehicle_change_request_flow.sql",
  import.meta.url,
);
const DOCUMENTS_PAGE = new URL("../../../src/pages/Documents.tsx", import.meta.url);
const VEHICLES_PAGE = new URL("../../../src/pages/Vehicles.tsx", import.meta.url);

function fnBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert(start >= 0, `${name} missing`);
  // Prefer the last definition when the migration redefines a function.
  let last = start;
  let cursor = start + 1;
  while (true) {
    const next = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`, cursor);
    if (next < 0) break;
    last = next;
    cursor = next + 1;
  }
  const end = sql.indexOf("\n$$;", last);
  assert(end > last, `${name} body not terminated`);
  return sql.slice(last, end);
}

Deno.test("submit creates a new pending vehicle; does not mutate previous identity fields", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  const submit = fnBody(sql, "submit_driver_vehicle_change_request");
  assert(submit.includes("INSERT INTO public.vehicles"), "must insert a new vehicle row");
  assert(submit.includes("requested_vehicle_id"), "must link the new vehicle on the request");
  assertEquals(submit.includes("vehicle_edit_request_status"), false);
  assertEquals(/p_vehicle_id/.test(submit), false, "vehicle is never taken from the client");
  // Previous row may be suspended, but identity columns must not be rewritten.
  assertEquals(/UPDATE\s+public\.vehicles[\s\S]*SET[\s\S]*make\s*=/.test(submit), false);
  assertEquals(/UPDATE\s+public\.vehicles[\s\S]*SET[\s\S]*license_plate\s*=/.test(submit), false);
  assert(submit.includes("suspended_under_repair"));
  assert(submit.includes("p_reason"));
  assert(submit.includes("p_suspend_previous"));
});

Deno.test("approve activates the new vehicle without rewriting the previous plate/make/model", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  const decide = fnBody(sql, "admin_decide_vehicle_change_request");
  assert(decide.includes("requested_vehicle_id"));
  assert(decide.includes("'REQUESTED_VEHICLE_MISSING'"));
  assert(decide.includes("identity_preserved"));
  // Previous vehicle update clears trip-active / primary only — no make/model/plate assignment.
  const prevUpdate = decide.indexOf("WHERE id = v_prev.id");
  assert(prevUpdate > 0);
  const prevBlock = decide.slice(Math.max(0, prevUpdate - 500), prevUpdate);
  assertEquals(/make\s*=/.test(prevBlock), false, "previous vehicle make must not be rewritten");
  assertEquals(/license_plate\s*=/.test(prevBlock), false, "previous plate must not be rewritten");
  assert(decide.includes("suspended_under_repair"));
});

Deno.test("documents are vehicle-scoped; cross-vehicle supersession is blocked", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert(sql.includes("ADD COLUMN IF NOT EXISTS vehicle_id uuid"));
  assert(sql.includes("trg_documents_stamp_vehicle_id"));
  assert(sql.includes("trg_documents_vehicle_scoped_supersede"));
  assert(sql.includes("trg_documents_block_cross_vehicle_supersede"));
  const supersede = fnBody(sql, "trg_documents_vehicle_scoped_supersede");
  assert(supersede.includes("d.vehicle_id IS NOT DISTINCT FROM NEW.vehicle_id"));
  const block = fnBody(sql, "trg_documents_block_cross_vehicle_supersede");
  assert(block.includes("winner.vehicle_id IS DISTINCT FROM OLD.vehicle_id"));
  assert(sql.includes("ambiguity_review_required"));
});

Deno.test("primary and trip-active are distinct; Go Online uses trip-active approved vehicle", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert(sql.includes("ADD COLUMN IF NOT EXISTS is_trip_active boolean"));
  assert(sql.includes("COMMENT ON COLUMN public.vehicles.is_primary"));
  const presence = fnBody(sql, "assert_driver_presence_online_eligible");
  assert(presence.includes("v.is_trip_active = true"));
  assert(presence.includes("operational_status = 'active'"));
  const vehicleGate = presence.slice(
    presence.indexOf("FROM public.vehicles v"),
    presence.indexOf("INTO v_has_vehicle"),
  );
  assertEquals(
    vehicleGate.includes("is_primary"),
    false,
    "Go Online vehicle gate must not key off primary alone",
  );
});

Deno.test("shared return never deletes the asset; reactivation reuses valid docs", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert(sql.includes("CREATE TABLE IF NOT EXISTS public.vehicle_driver_assignments"));
  const ret = fnBody(sql, "admin_return_shared_vehicle_assignment");
  assert(ret.includes("available_in_fleet"));
  assertEquals(/DELETE\s+FROM\s+public\.vehicles/i.test(ret), false);
  assert(ret.includes("documents_preserved"));
  const reactivate = fnBody(sql, "admin_reactivate_driver_vehicle");
  assert(reactivate.includes("'DOCUMENTS_INVALID'"));
  assert(reactivate.includes("reused_documents"));
});

Deno.test("legacy vehicle-doc association is certain-only; multi-vehicle rows are flagged", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert(sql.includes("HAVING count(*) = 1"));
  assert(sql.includes("ambiguity_review_required = true"));
  assert(sql.includes("HAVING count(*) > 1"));
});

Deno.test("expanded vehicle document slug set still intersects service-area rules", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  const slugs = fnBody(sql, "vehicle_change_document_slugs");
  for (const slug of [
    "v5_logbook",
    "additional_insurance_document",
    "phv_license",
    "exemption_certificate",
  ]) {
    assert(slugs.includes(`'${slug}'`), slug);
  }
  const applicable = fnBody(sql, "vehicle_change_applicable_documents");
  assert(applicable.includes("get_driver_document_eligibility_internal"));
  assert(applicable.includes("required_documents"));
  assert(applicable.includes("resolve_vehicle_document_target"));
});

Deno.test("Admin Documents and Vehicles surfaces expose vehicle identity / operational status", async () => {
  const docs = await Deno.readTextFile(DOCUMENTS_PAGE);
  assert(docs.includes("vehicle_id"));
  assert(docs.includes("license_plate"));
  assert(docs.includes("Ambiguous vehicle link") || docs.includes("ambiguity_review_required"));
  const vehicles = await Deno.readTextFile(VEHICLES_PAGE);
  assert(vehicles.includes("Suspended — Under repair"));
  assert(vehicles.includes("Available in fleet"));
  assert(vehicles.includes("operational_status"));
});

Deno.test("legacy submit lock remains: original migration never mutated vehicles on submit", async () => {
  const sql = await Deno.readTextFile(LEGACY_MIGRATION);
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.submit_driver_vehicle_change_request(");
  const end = sql.indexOf("\n$$;", start);
  const submit = sql.slice(start, end);
  assertEquals(/UPDATE\s+public\.vehicles/i.test(submit), false);
});
