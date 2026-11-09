/**
 * Lock: admin_page_mutate must quote JSON arrays as Postgres ARRAY literals
 * so document_types.reminder_days_before_expiry (integer[]) updates succeed.
 * Broken quoting aborted the whole UPDATE — including display-name renames.
 */
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20261231182000_fix_admin_page_quote_json_array.sql",
  import.meta.url,
);

Deno.test("admin page quote json array migration emits ARRAY[] / empty {} literals", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assertStringIncludes(sql, "jsonb_typeof(p_val) = 'array'");
  assertStringIncludes(sql, "RETURN '''{}'''");
  assertStringIncludes(sql, "RETURN 'ARRAY[' || array_to_string(v_parts, ',') || ']'");
  assertStringIncludes(sql, "reminder_days_before_expiry");
});
