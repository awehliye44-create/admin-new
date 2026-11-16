/**
 * Lock: admin_page_mutate UPDATE must use a writable CTE, never
 * SELECT … FROM (UPDATE … RETURNING …) q — that yields
 * "syntax error at or near '.'" and breaks document approve/reject.
 */
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20261231183000_fix_admin_page_mutate_update_cte.sql",
  import.meta.url,
);

Deno.test("admin_page_mutate update uses writable CTE and document guard bypass", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assertStringIncludes(
    sql,
    "WITH updated AS (UPDATE public.%I SET %s WHERE %s RETURNING *) SELECT COALESCE(jsonb_agg(to_jsonb(u)), ''[]''::jsonb) FROM updated u",
  );
  assertStringIncludes(sql, "set_config('onecab.admin_page_mutate', '1', true)");
  assertStringIncludes(sql, "current_setting('onecab.admin_page_mutate', true) = '1'");
  assertEquals(
    sql.includes("FROM (' || v_sql || ') q"),
    false,
    "must not wrap UPDATE in FROM (subquery)",
  );
  assertEquals(
    sql.includes("RETURNING to_jsonb(%I.*)"),
    true,
    "INSERT path may still use RETURNING to_jsonb(table.*)",
  );
});
