/**
 * LOCK — vehicle lifecycle UI wiring (assign / return / reactivate / ambiguity /
 * upload ownership / My Documents active-vehicle scope).
 *
 * Run: deno test --allow-read supabase/tests/_shared/vehicleLifecycleUiWiringLock.test.ts
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIG = new URL(
  "../../migrations/20270305110000_vehicle_lifecycle_ui_and_upload_hardening.sql",
  import.meta.url,
);
const LIFECYCLE = new URL(
  "../../migrations/20270305100000_vehicle_replacement_lifecycle_ssot.sql",
  import.meta.url,
);
const VEHICLES_PAGE = new URL("../../../src/pages/Vehicles.tsx", import.meta.url);
const DOCUMENTS_PAGE = new URL("../../../src/pages/Documents.tsx", import.meta.url);
const DRIVER_DETAILS = new URL(
  "../../../src/components/drivers/DriverDetailsDialog.tsx",
  import.meta.url,
);
const ADMIN_LIB = new URL("../../../src/lib/vehicleLifecycleAdmin.ts", import.meta.url);

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

Deno.test("assign / return / reactivate RPCs preserve assets and documents", async () => {
  const sql = await Deno.readTextFile(MIG);
  const lifecycle = await Deno.readTextFile(LIFECYCLE);
  const assign = fnBody(sql, "admin_assign_shared_vehicle");
  assert(assign.includes("temporary_replacement"));
  assert(assign.includes("vehicle_driver_assignments"));
  assert(assign.includes("suspended_under_repair"));
  assertEquals(/DELETE\s+FROM\s+public\.vehicles/i.test(assign), false);

  const ret = fnBody(lifecycle, "admin_return_shared_vehicle_assignment");
  assert(ret.includes("available_in_fleet"));
  assert(ret.includes("documents_preserved"));
  assertEquals(/DELETE\s+FROM\s+public\.vehicles/i.test(ret), false);

  const reactivate = fnBody(lifecycle, "admin_reactivate_driver_vehicle");
  assert(reactivate.includes("reused_documents"));
  assert(reactivate.includes("'DOCUMENTS_INVALID'"));
});

Deno.test("My Documents SSOT uses trip-active vehicle; stamp validates ownership", async () => {
  const sql = await Deno.readTextFile(MIG);
  assert(sql.includes("resolve_trip_active_vehicle_id(dr.id) AS vehicle_id"));
  assertEquals(
    sql.includes("resolve_vehicle_document_target(dr.id) AS vehicle_id"),
    false,
    "normal My Documents must not prefer pending replacement target",
  );
  const stamp = fnBody(sql, "trg_documents_stamp_vehicle_id");
  assert(stamp.includes("assert_document_vehicle_ownership"));
  assert(stamp.includes("DOCUMENT_VEHICLE_OWNERSHIP_MISMATCH") ||
    sql.includes("DOCUMENT_VEHICLE_OWNERSHIP_MISMATCH"));
  assert(stamp.includes("resolve_vehicle_document_target"));
});

Deno.test("ambiguity resolve requires same-driver vehicle", async () => {
  const sql = await Deno.readTextFile(MIG);
  const resolve = fnBody(sql, "admin_resolve_document_vehicle_link");
  assert(resolve.includes("'VEHICLE_OWNERSHIP_MISMATCH'"));
  assert(resolve.includes("ambiguity_review_required = false"));
  assert(resolve.includes("document_vehicle_link_resolved"));
});

Deno.test("Admin Vehicles / Driver Details / Documents expose assign, return, reactivate, resolve", async () => {
  const vehicles = await Deno.readTextFile(VEHICLES_PAGE);
  assert(vehicles.includes("Assign to driver"));
  assert(vehicles.includes("Return to fleet"));
  assert(vehicles.includes("adminAssignSharedVehicle"));
  assert(vehicles.includes("adminReturnSharedVehicleAssignment"));
  // Searchable driver picker — never a pasted UUID field.
  assert(vehicles.includes("DriverSelector"));
  assert(vehicles.includes('pageSlug="vehicles"'));
  assert(vehicles.includes("driverOptionLabel"));
  assertEquals(/placeholder=["']Driver UUID/i.test(vehicles), false);
  assertEquals(/Paste driver UUID/i.test(vehicles), false);

  const details = await Deno.readTextFile(DRIVER_DETAILS);
  assert(details.includes("Reactivate (council clearance)"));
  assert(details.includes("Return to fleet"));
  assert(details.includes("adminReactivateDriverVehicle"));

  const docs = await Deno.readTextFile(DOCUMENTS_PAGE);
  assert(docs.includes("Resolve vehicle link"));
  assert(docs.includes("adminResolveDocumentVehicleLink"));
  assert(docs.includes("ambiguous"));

  const lib = await Deno.readTextFile(ADMIN_LIB);
  assert(lib.includes("admin_assign_shared_vehicle"));
  assert(lib.includes("admin_return_shared_vehicle_assignment"));
  assert(lib.includes("admin_reactivate_driver_vehicle"));
  assert(lib.includes("admin_resolve_document_vehicle_link"));
  assert(lib.includes("ALREADY_ASSIGNED"));
  assert(lib.includes("NOT_AVAILABLE_IN_FLEET"));
});

Deno.test("driver list/primary/remove and replacement docs RPCs exist", async () => {
  const sql = await Deno.readTextFile(MIG);
  assert(sql.includes("list_driver_saved_vehicles"));
  assert(sql.includes("get_my_vehicle_change_applicable_documents"));
  assert(sql.includes("can_set_primary"));
  assert(sql.includes("can_remove"));
  assert(sql.includes("'Action required'"));
  assert(sql.includes("sides_on_file"));
  assert(sql.includes("'Back required'"));
  assert(sql.includes("document_attachments"));
});

Deno.test("Admin management controls migration adds page-RBAC lifecycle actions", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20270305120000_vehicle_admin_management_controls.sql", import.meta.url),
  );
  assert(sql.includes("admin_set_trip_active_vehicle"));
  assert(sql.includes("admin_suspend_driver_vehicle"));
  assert(sql.includes("admin_archive_driver_vehicle"));
  assert(sql.includes("admin_retire_document"));
  assert(sql.includes("staff_has_any_page_access"));
  assert(sql.includes("REASON_REQUIRED"));
  assert(sql.includes("documents_preserved"));
  assertEquals(/DELETE\s+FROM\s+public\.vehicles/i.test(sql), false);
  assertEquals(/DELETE\s+FROM\s+public\.documents/i.test(sql), false);
});
