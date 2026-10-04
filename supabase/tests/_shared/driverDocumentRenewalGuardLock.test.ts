/**
 * Lock: Driver document renewal must not be rejected by the privileged-column
 * guard, and the guard must still reject any Driver-chosen privileged value.
 *
 * Incident 2026-10-04 (MK0007, private_hire_insurance renewal): upload failed
 * with DRIVER_PRIVILEGED_FIELD_FORBIDDEN because update_driver_docs_status
 * re-derived documents_approved / onboarding_complete under the Driver's
 * auth.uid() and the guard forbade every change to those columns.
 *
 * If this fails, fix the code — never delete or soften the lock.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION =
  "../../migrations/20261213120000_driver_privileged_guard_allow_derived_document_flags.sql";
const ROLLBACK =
  "../../migrations/rollback/rollback_20261213120000_driver_privileged_guard_allow_derived_document_flags.sql";

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, import.meta.url));
}

function code(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

Deno.test("guard stays SECURITY DEFINER with pinned search_path and no transaction control", async () => {
  const sql = await read(MIGRATION);
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.enforce_driver_privileged_column_guard()");
  assertStringIncludes(sql, "SECURITY DEFINER");
  assertStringIncludes(sql, "SET search_path TO 'public'");
  assertEquals(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(code(sql)), false);
});

Deno.test("approval_status and driver_status remain unconditionally forbidden for the Driver session", async () => {
  const sql = code(await read(MIGRATION));
  assertEquals(
    /IF NEW\.approval_status IS DISTINCT FROM OLD\.approval_status THEN\s+RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN'/.test(sql),
    true,
  );
  assertEquals(
    /IF NEW\.driver_status IS DISTINCT FROM OLD\.driver_status THEN\s+RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN'/.test(sql),
    true,
  );
  assertStringIncludes(sql, "auth.uid() = OLD.user_id");
});

Deno.test("document flags may change only to the server-derived compliance value", async () => {
  const sql = code(await read(MIGRATION));
  assertStringIncludes(sql, "public.check_driver_documents_approved(OLD.id)");
  assertStringIncludes(sql, "NEW.documents_approved IS DISTINCT FROM v_derived_documents_approved");
  assertStringIncludes(sql, "NEW.onboarding_complete IS DISTINCT FROM v_derived_documents_approved");
  // Never a blanket allow, a GUC bypass, or a trigger-depth bypass for these flags.
  assertEquals(/pg_trigger_depth/i.test(sql), false);
  assertEquals(/allow_driver_document/i.test(sql), false);
  assertEquals((sql.match(/'DRIVER_PRIVILEGED_FIELD_FORBIDDEN'/g) ?? []).length, 5);
});

Deno.test("Terms forge guard and presence ownership are unchanged", async () => {
  const sql = code(await read(MIGRATION));
  assertStringIncludes(sql, "current_setting('onecab.allow_driver_terms_write', true)");
  assertStringIncludes(sql, "NEW.terms_accepted_at IS DISTINCT FROM OLD.terms_accepted_at");
  assertStringIncludes(sql, "NEW.terms_version IS DISTINCT FROM OLD.terms_version");
  assertEquals(/NEW\.is_online IS DISTINCT FROM OLD\.is_online/.test(sql), false);
  assertEquals(/NEW\.driver_online_intent IS DISTINCT FROM OLD\.driver_online_intent/.test(sql), false);
});

Deno.test("migration touches only the guard function", async () => {
  const sql = code(await read(MIGRATION));
  assertEquals((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 1);
  assertEquals(/\b(INSERT INTO|DELETE FROM|ALTER TABLE|DROP |GRANT |REVOKE |CREATE TRIGGER)\b/i.test(sql), false);
  assertEquals(/\bUPDATE\s+public\./i.test(sql), false);
});

Deno.test("rollback restores the previous blanket guard", async () => {
  const sql = code(await read(ROLLBACK));
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.enforce_driver_privileged_column_guard()");
  assertEquals(
    /IF NEW\.documents_approved IS DISTINCT FROM OLD\.documents_approved THEN\s+RAISE EXCEPTION/.test(sql),
    true,
  );
  assertEquals(sql.includes("check_driver_documents_approved"), false);
});
