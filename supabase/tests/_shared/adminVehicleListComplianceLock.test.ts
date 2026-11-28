/**
 * LOCK — Admin Vehicles authorized list + vehicle-scoped document compliance RPC.
 * Run: deno test --allow-read supabase/tests/_shared/adminVehicleListComplianceLock.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIG = new URL(
  "../../migrations/20270305130000_admin_vehicle_list_doc_compliance_history.sql",
  import.meta.url,
);
const VEHICLES = new URL("../../../src/pages/Vehicles.tsx", import.meta.url);
const LIB = new URL("../../../src/lib/vehicleLifecycleAdmin.ts", import.meta.url);

function fnBody(sql: string, name: string): string {
  let last = -1;
  let cursor = 0;
  while (true) {
    const next = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`, cursor);
    if (next < 0) break;
    last = next;
    cursor = next + 1;
  }
  assert(last >= 0, `${name} missing`);
  const end = sql.indexOf("\n$$;", last);
  assert(end > last, `${name} body not terminated`);
  return sql.slice(last, end);
}

Deno.test("compliance summaries authorize via page RBAC and fail closed for anon", async () => {
  const sql = await Deno.readTextFile(MIG);
  const body = fnBody(sql, "admin_vehicle_document_compliance_summaries");
  assert(body.includes("staff_has_any_page_access"));
  assert(body.includes("'vehicles'"));
  assert(body.includes("'documents'"));
  assert(body.includes("42501"));
  assert(sql.includes("REVOKE ALL ON FUNCTION public.admin_vehicle_document_compliance_summaries"));
  assertEquals(/GRANT EXECUTE[^;]*TO anon/i.test(sql), false);
});

Deno.test("compliance uses SA rules ∩ vehicle slugs and only that vehicle_id", async () => {
  const sql = await Deno.readTextFile(MIG);
  const body = fnBody(sql, "admin_vehicle_document_compliance_summaries");
  assert(body.includes("vehicle_change_document_slugs()"));
  assert(body.includes("get_driver_document_eligibility_internal"));
  assert(body.includes("jsonb_array_elements_text"));
  assert(body.includes("d.vehicle_id = v_vehicle.id"));
  assertEquals(/d\.vehicle_id\s+IS\s+NOT\s+DISTINCT\s+FROM/i.test(body), false);
  assert(body.includes("'action_needed'"));
  assert(body.includes("'pending_review'"));
  assert(body.includes("'complete'"));
});

Deno.test("change-request list is page-gated; Vehicles page avoids direct table reads", async () => {
  const sql = await Deno.readTextFile(MIG);
  const list = fnBody(sql, "admin_list_vehicle_change_requests");
  assert(list.includes("staff_has_any_page_access"));
  assert(list.includes("vehicle_change_requests"));

  const vehicles = await Deno.readTextFile(VEHICLES);
  assert(vehicles.includes("adminPageSelect"));
  assert(vehicles.includes("adminListVehicleChangeRequests"));
  assert(vehicles.includes("adminVehicleDocumentComplianceSummaries"));
  assertEquals(/\.from\(\s*['"]vehicles['"]\s*\)/.test(vehicles), false);
  assertEquals(/\.from\(\s*['"]vehicle_change_requests['"]\s*\)/.test(vehicles), false);

  const lib = await Deno.readTextFile(LIB);
  assert(lib.includes("admin_list_vehicle_change_requests"));
  assert(lib.includes("admin_vehicle_document_compliance_summaries"));
});
