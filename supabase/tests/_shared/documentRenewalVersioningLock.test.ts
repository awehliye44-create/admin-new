/**
 * LOCK — eligible renewal may demote an approved row (is_current / superseded_by)
 * without mutating approved content. Do not unlock content edits via
 * can_upload_replacement. Do not add client isRenewal flags.
 *
 * Run: deno test --allow-read supabase/functions/_shared/documentRenewalVersioningLock.test.ts
 */

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const forward = new URL(
  "../../migrations/20261026150000_document_renewal_versioning_lock.sql",
  import.meta.url,
);
const rollback = new URL(
  "../../migrations/rollback/rollback_20261026150000_document_renewal_versioning_lock.sql",
  import.meta.url,
);

async function read(url: URL): Promise<string> {
  return await Deno.readTextFile(url);
}

Deno.test("forward migration allows versioning-only approved updates", async () => {
  const sql = await read(forward);
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.enforce_document_lock()");
  assertStringIncludes(sql, "document_update_is_versioning_only");
  assertStringIncludes(sql, "has_role(auth.uid(), 'admin'::app_role)");
  assertStringIncludes(
    sql,
    "RAISE EXCEPTION 'Cannot modify an approved document. Contact admin to unlock it.'",
  );
  assertStringIncludes(sql, "OLD.expiry_date < today_london");
  assertStringIncludes(sql, "p_old.file_url IS NOT DISTINCT FROM p_new.file_url");
  assertStringIncludes(sql, "p_old.status IS NOT DISTINCT FROM p_new.status");
  assertStringIncludes(sql, "p_old.expiry_date IS NOT DISTINCT FROM p_new.expiry_date");
  assertStringIncludes(sql, "p_old.document_type_id IS NOT DISTINCT FROM p_new.document_type_id");
  assertStringIncludes(sql, "p_old.driver_id IS NOT DISTINCT FROM p_new.driver_id");
  assertStringIncludes(sql, "p_old.reviewed_by IS NOT DISTINCT FROM p_new.reviewed_by");
  assertStringIncludes(sql, "is_current, superseded_by, and/or updated_at");
});

Deno.test("forward migration does not unlock content via can_upload_replacement", async () => {
  const sql = await read(forward);
  assertEquals(/IF\s+.*can_upload_replacement/i.test(sql), false);
  assertStringIncludes(sql, "Do NOT unlock content edits");
  assertEquals(sql.includes("isRenewal"), false);
  assertEquals(sql.includes("CREATE OR REPLACE FUNCTION public.submit_driver_document"), false);
  assertEquals(/CREATE VIEW public\.driver_document_compliance_ssot/i.test(sql), false);
});

Deno.test("guard skips versioning-only approved updates so history stays approved", async () => {
  const sql = await read(forward);
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.guard_driver_document_writes()");
  const guardIdx = sql.indexOf("CREATE OR REPLACE FUNCTION public.guard_driver_document_writes()");
  const guard = sql.slice(guardIdx);
  assertStringIncludes(guard, "OLD.status = 'approved'");
  assertStringIncludes(guard, "document_update_is_versioning_only(OLD, NEW)");
  assertStringIncludes(guard, "NEW.status := 'pending'");
});

Deno.test("rollback restores the previous lock without versioning exception", async () => {
  const sql = await read(rollback);
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.enforce_document_lock()");
  assertStringIncludes(
    sql,
    "RAISE EXCEPTION 'Cannot modify an approved document. Contact admin to unlock it.'",
  );
  assertEquals(sql.includes("document_update_is_versioning_only(OLD, NEW)"), false);
  assertStringIncludes(sql, "DROP FUNCTION IF EXISTS public.document_update_is_versioning_only");
});

Deno.test("SSOT can_upload_replacement remains defined outside this migration", async () => {
  const types = await Deno.readTextFile(
    new URL("../../../src/integrations/supabase/types.ts", import.meta.url),
  );
  assertStringIncludes(types, "can_upload_replacement");
  assertStringIncludes(types, "submit_driver_document");
});
