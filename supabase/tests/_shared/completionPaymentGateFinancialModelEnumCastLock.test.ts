/**
 * Lock: assert_trip_completion_customer_payment_gate must cast financial_model
 * to text before COALESCE. COALESCE(enum, '') raises
 * "invalid input value for enum service_area_financial_model: \"\"" even when
 * the column is non-null — blocking every Complete Trip (MK-261106-004).
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20261230160000_completion_payment_gate_financial_model_enum_cast_lock.sql",
  import.meta.url,
);

const PRIOR_BROKEN = new URL(
  "../../migrations/20261230150000_mk261105002_mod_challenge_midtrip_recovery.sql",
  import.meta.url,
);

Deno.test("completion gate lock migration casts financial_model::text before COALESCE", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assertStringIncludes(sql, "assert_trip_completion_customer_payment_gate");
  assertStringIncludes(sql, "financial_model::text");
  assertStringIncludes(
    sql,
    "upper(trim(COALESCE(v_trip.financial_model::text, '')))",
  );
  // Forbidden: COALESCE(enum, '') without ::text — crashes every completion.
  assertEquals(sql.includes("COALESCE(v_trip.financial_model, '')"), false);
  assertEquals(sql.includes("v_trip.metadata"), false);
  assertStringIncludes(sql, "FOR UPDATE");
  assertStringIncludes(sql, "CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED");
  assertStringIncludes(sql, "mid_trip_payment_auth_lost_recovery");
  assertStringIncludes(sql, "payment_hold_status");
});

Deno.test("prior mid-trip recovery migration is superseded by enum-cast lock", async () => {
  const prior = await Deno.readTextFile(PRIOR_BROKEN);
  const lock = await Deno.readTextFile(MIGRATION);
  // Document the bug we fixed — prior file still shows the unsafe pattern.
  assertEquals(
    /COALESCE\(\s*v_trip\.financial_model\s*,\s*''\s*\)/.test(prior),
    true,
  );
  assertStringIncludes(lock, "cast enum → text before COALESCE");
  assertStringIncludes(lock, "purpose::text");
});
