/**
 * #111D LOCK — get_driver_own_wallet_recent_activity security contract.
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

const migPath = new URL(
  "../../migrations/20270304181000_bug111c_driver_wallet_recent_activity_ssot.sql",
  import.meta.url,
);

Deno.test("#111D Activity RPC is SECURITY DEFINER with safe search_path", async () => {
  const sql = await Deno.readTextFile(migPath);
  assertStringIncludes(sql, "SECURITY DEFINER");
  assertStringIncludes(sql, "SET search_path TO 'pg_catalog', 'public'");
  assertStringIncludes(sql, "driver_wallet_jwt_role()");
  assertStringIncludes(sql, "current_driver_id()");
  assertStringIncludes(sql, "IF v_role IS DISTINCT FROM 'authenticated'");
  assertStringIncludes(sql, "WHERE dwl.driver_id = v_driver_id");
});

Deno.test("#111D Activity RPC grants are authenticated-only", async () => {
  const sql = await Deno.readTextFile(migPath);
  assertStringIncludes(
    sql,
    "REVOKE ALL ON FUNCTION public.get_driver_own_wallet_recent_activity(integer, timestamptz)",
  );
  assertStringIncludes(sql, "FROM PUBLIC, anon, service_role");
  assertStringIncludes(
    sql,
    "GRANT EXECUTE ON FUNCTION public.get_driver_own_wallet_recent_activity(integer, timestamptz)",
  );
  assertStringIncludes(sql, "TO authenticated");
});

Deno.test("#111D Activity RPC bounds result size and avoids passenger PII columns", async () => {
  const sql = await Deno.readTextFile(migPath);
  assertStringIncludes(sql, "LEAST(COALESCE(p_limit, 20), 100)");
  assertEquals(/passenger_id|customer_id|phone|email|pickup_address|dropoff_address/.test(sql), false);
  assertStringIncludes(sql, "trip_code");
  assertStringIncludes(sql, "earning_category");
  assertStringIncludes(sql, "clearing_status");
});
