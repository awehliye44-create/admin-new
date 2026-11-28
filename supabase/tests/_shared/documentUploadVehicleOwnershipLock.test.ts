/**
 * LOCK — document upload callers must not bypass vehicle ownership.
 *
 * Stamp trigger + assert_document_vehicle_ownership are SSOT for vehicle_id.
 * Callers must not invent vehicle ids for another driver; admin resolve is
 * the only explicit re-link path and checks driver match.
 *
 * Run: deno test --allow-read supabase/tests/_shared/documentUploadVehicleOwnershipLock.test.ts
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIG = new URL(
  "../../migrations/20270305110000_vehicle_lifecycle_ui_and_upload_hardening.sql",
  import.meta.url,
);
const ADMIN_SUBMIT = new URL(
  "../../migrations/20270226150000_admin_submit_driver_document_idempotency_uuid.sql",
  import.meta.url,
);
const ADMIN_UPLOAD = new URL("../../../src/lib/adminDocumentUploadSubmit.ts", import.meta.url);

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

Deno.test("stamp trigger validates ownership and forces pending replacement target", async () => {
  const sql = await Deno.readTextFile(MIG);
  const assertFn = fnBody(sql, "assert_document_vehicle_ownership");
  assert(assertFn.includes("v.driver_id IS NOT DISTINCT FROM p_driver_id"));
  assert(assertFn.includes("DOCUMENT_VEHICLE_OWNERSHIP_MISMATCH"));

  const stamp = fnBody(sql, "trg_documents_stamp_vehicle_id");
  assert(stamp.includes("assert_document_vehicle_ownership"));
  assert(stamp.includes("resolve_vehicle_document_target"));
  assert(stamp.includes("requested_vehicle_id = v_target"));
  // Driver-scoped docs must clear vehicle_id
  assert(stamp.includes("NEW.vehicle_id := NULL"));
});

Deno.test("admin_submit_driver_document does not accept a client vehicle_id argument", async () => {
  const sql = await Deno.readTextFile(ADMIN_SUBMIT);
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.admin_submit_driver_document(");
  assert(start >= 0);
  const sigEnd = sql.indexOf(")", start);
  const sig = sql.slice(start, sigEnd);
  assertEquals(/p_vehicle_id/i.test(sig), false, "admin submit must not take p_vehicle_id");
});

Deno.test("admin upload sends the confirmed vehicle and the server checks ownership", async () => {
  const src = await Deno.readTextFile(ADMIN_UPLOAD);
  assert(src.includes("admin_submit_driver_document"));
  assert(src.includes("p_vehicle_id"));
  const mig = await Deno.readTextFile(
    new URL(
      "../../migrations/20270305290000_admin_vehicle_remove_and_document_target.sql",
      import.meta.url,
    ),
  );
  assert(mig.includes("v.driver_id = p_driver_id"));
  assert(mig.includes("p_vehicle_id IS NOT NULL"));
  assert(mig.includes("p_vehicle_id IS NULL"));
  assert(mig.includes("Omitted vehicle id"));
  assert(mig.includes("ACTIVE_IN_USE"));
  assert(mig.includes("documents_preserved"));
  assert(mig.includes("onecab.admin_document_vehicle_id"));
  assert(!mig.includes("DELETE FROM public.documents"));
  assert(!mig.includes("DELETE FROM public.vehicles"));
});

Deno.test("cross-vehicle supersession remains blocked in lifecycle migration", async () => {
  const lifecycle = await Deno.readTextFile(
    new URL("../../migrations/20270305100000_vehicle_replacement_lifecycle_ssot.sql", import.meta.url),
  );
  assert(lifecycle.includes("trg_documents_block_cross_vehicle_supersede"));
  assert(lifecycle.includes("winner.vehicle_id IS DISTINCT FROM OLD.vehicle_id"));
});
