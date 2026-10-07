/**
 * LOCK — driver vehicle change request flow.
 *
 * Behaviour is proven by supabase/tests/driver_vehicle_change_request_isolated.sh
 * (real Postgres). This lock pins the invariants that must never be simplified:
 *  - submit never sets drivers.vehicle_edit_request_status = 'pending'
 *    (assert_driver_presence_online_eligible blocks going online on it, and the
 *    approved vehicle must stay usable while a request is pending);
 *  - drivers and admins never write vehicle_change_requests directly;
 *  - one pending request per driver, enforced by a partial unique index;
 *  - approval reviews the service-area vehicle documents via the eligibility
 *    SSOT and rechecks categories, all inside one admin RPC (atomic);
 *  - the admin page decides through that RPC only.
 *
 * Run: deno test --allow-read supabase/tests/_shared/vehicleChangeRequestFlowLock.test.ts
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20261214120000_driver_vehicle_change_request_flow.sql",
  import.meta.url,
);
const ADMIN_PAGE = new URL("../../../src/pages/Vehicles.tsx", import.meta.url);
const ADMIN_REVIEW_DIALOG = new URL(
  "../../../src/components/vehicles/VehicleChangeReviewDialog.tsx",
  import.meta.url,
);

function fnBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert(start >= 0, `${name} missing`);
  const end = sql.indexOf("\n$$;", start);
  assert(end > start, `${name} body not terminated`);
  return sql.slice(start, end);
}

Deno.test("submit never writes the presence-blocking pending status", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  const submit = fnBody(sql, "submit_driver_vehicle_change_request");
  assertEquals(submit.includes("vehicle_edit_request_status"), false);
  assertEquals(/UPDATE\s+public\.vehicles/i.test(submit), false, "submit must not touch the vehicle");
  assert(submit.includes("'pending'"));
  assert(/WHERE d\.user_id = v_uid AND d\.deleted_at IS NULL\s+FOR UPDATE/.test(submit), "ownership from auth.uid()");
  assertEquals(/p_vehicle_id/.test(submit), false, "vehicle is never taken from the client");
});

Deno.test("no direct writes to vehicle_change_requests", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert(sql.includes('DROP POLICY IF EXISTS "Drivers can create change requests for their vehicles"'));
  assert(sql.includes('DROP POLICY IF EXISTS "Drivers can view their own change requests"'));
  assert(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER\s+ON public\.vehicle_change_requests FROM authenticated/.test(sql));
  assert(sql.includes("REVOKE ALL ON public.vehicle_change_requests FROM anon"));
  assertEquals(/CREATE POLICY[^;]*vehicle_change_requests/i.test(sql), false);
});

Deno.test("one pending request per driver and final decisions", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert(/CREATE UNIQUE INDEX IF NOT EXISTS vehicle_change_requests_one_pending_per_driver\s+ON public\.vehicle_change_requests \(driver_id\)\s+WHERE status = 'pending'/.test(sql));
  assert(sql.includes("CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'))"));
  const guard = fnBody(sql, "vehicle_change_requests_guard");
  assert(guard.includes("IF OLD.status <> 'pending' THEN"));
});

Deno.test("approval gates: vehicle documents via eligibility SSOT, category recheck, atomic", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  const docs = fnBody(sql, "vehicle_change_applicable_documents");
  assert(docs.includes("public.get_driver_document_eligibility_internal(p_driver_id)"));
  assert(docs.includes("'required_documents'"));
  assert(docs.includes("COALESCE(d.is_current, true) = true"));
  const slugs = fnBody(sql, "vehicle_change_document_slugs");
  for (const slug of ["v5_logbook", "mot_certificate", "phv_license", "private_hire_insurance"]) {
    assert(slugs.includes(`'${slug}'`), slug);
  }

  const decide = fnBody(sql, "admin_decide_vehicle_change_request");
  assert(decide.includes("NOT public.has_role(v_uid, 'admin'::app_role)"));
  assert(decide.includes("FOR UPDATE"));
  const order = [
    "'VEHICLE_OWNERSHIP_MISMATCH'",
    "'VEHICLE_CHANGED_SINCE_REQUEST'",
    "'DOCUMENT_RULES_UNAVAILABLE'",
    "'VEHICLE_DOCUMENTS_NOT_COMPLIANT'",
    "'VEHICLE_DOCUMENTS_NOT_REVIEWED'",
    "'CATEGORY_RECHECK_REQUIRED'",
    "'NO_ELIGIBLE_CATEGORY'",
    "UPDATE public.vehicles",
  ].map((needle) => {
    const at = decide.indexOf(needle);
    assert(at >= 0, `${needle} missing`);
    return at;
  });
  assertEquals([...order].sort((a, b) => a - b), order, "every gate runs before the vehicle is updated");
  assert(decide.includes("'REJECTION_REASON_REQUIRED'"));

  const cats = fnBody(sql, "driver_effective_vehicle_categories");
  assert(cats.includes("THEN COALESCE(dvc.is_enabled, true)"), "default category on unless disabled");
  assert(cats.includes("ELSE COALESCE(dvc.is_enabled, false)"), "other categories need an enabled row");
});

Deno.test("driver never receives internal admin notes", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  const json = fnBody(sql, "vehicle_change_request_json");
  assertEquals(json.includes("admin_notes"), false);
});

Deno.test("admin page decides through the atomic RPC only", async () => {
  const page = await Deno.readTextFile(ADMIN_PAGE);
  const dialog = await Deno.readTextFile(ADMIN_REVIEW_DIALOG);
  assert(page.includes("VehicleChangeReviewDialog"));
  assert(dialog.includes("rpc('admin_decide_vehicle_change_request'"));
  assert(dialog.includes("rpc('admin_get_vehicle_change_review'"));
  assert(dialog.includes("p_reviewed_document_ids"));
  assert(dialog.includes("p_enabled_vehicle_type_ids"));
  for (const src of [page, dialog]) {
    assertEquals(/from\('vehicle_change_requests'\)\s*\.(update|insert|upsert|delete)\(/.test(src), false);
    assertEquals(/from\('vehicles'\)\s*\.(update|upsert)\(/.test(src), false);
    assertEquals(/from\('driver_vehicle_categories'\)/.test(src), false);
    assertEquals(/vehicle_edit_request_status:/.test(src), false);
  }
});
