/**
 * Lock: a driver cannot rewrite the fare, capture, commission, payment or
 * outcome columns of their own finished trip through the REST API (driver
 * UPDATE policies on trips have no status or column limit).
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL("../../migrations/20261216240000_finished_trip_money_column_guard.sql", import.meta.url),
);
const rollback = await Deno.readTextFile(
  new URL("../../migrations/rollback/rollback_20261216240000_finished_trip_money_column_guard.sql", import.meta.url),
);

function lockedColumns(): string[] {
  const body = migration.slice(
    migration.indexOf("SELECT ARRAY["),
    migration.indexOf("]::text[];"),
  );
  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

Deno.test("guard fires first on every trips UPDATE", () => {
  assert(migration.includes("CREATE TRIGGER aa_guard_finished_trip_money_columns"));
  assert(migration.includes("BEFORE UPDATE ON public.trips"));
  assert(migration.includes("FOR EACH ROW"));
  assertEquals(/BEFORE UPDATE OF /.test(migration), false, "must not be column-scoped");
});

Deno.test("guard targets direct client writes on finished trips only", () => {
  assert(migration.includes("IF current_user <> 'authenticated' THEN"));
  assert(migration.includes("lower(COALESCE(OLD.status, '')) <> 'completed'"));
  assert(migration.includes("AND OLD.completed_at IS NULL"));
  assert(migration.includes("public.is_trip_terminal_cancel_status("));
  assert(migration.includes("public.has_role(auth.uid(), 'admin'::app_role)"));
  assert(migration.includes("RAISE EXCEPTION 'FINISHED_TRIP_MONEY_LOCKED:"));
  assert(migration.includes("ERRCODE = '42501'"));
  const guardAt = migration.indexOf("CREATE OR REPLACE FUNCTION public.guard_finished_trip_money_columns()");
  const guardHeader = migration.slice(guardAt, migration.indexOf("AS $function$", guardAt));
  assert(guardAt > 0);
  assertEquals(/SECURITY DEFINER/.test(guardHeader), false, "guard must run with caller rights");
});

Deno.test("locked columns cover fare, capture, commission, payment and outcome", () => {
  const cols = lockedColumns();
  for (const c of [
    "fare",
    "final_fare_pence",
    "final_customer_fare_pence",
    "gross_fare_pence",
    "capture_amount_pence",
    "authorised_amount_pence",
    "commission_pence",
    "driver_net_pence",
    "driver_total_earnings_pence",
    "final_payout_pence",
    "financial_model",
    "financial_outcome",
    "cancellation_fee_pence",
    "late_cancel_fee_pence",
    "no_show_charge_pence",
    "payment_status",
    "payment_session_id",
    "provider_payment_id",
    "refund_amount_pence",
    "tip_amount_pence",
    "customer_modification_charge_pence",
    "offer_discount_pence",
    "voucher_discount_pence",
  ]) {
    assert(cols.includes(c), `missing ${c}`);
  }
  assertEquals(new Set(cols).size, cols.length, "duplicate column");
  for (const notMoney of ["driver_passenger_feedback", "passenger_rating", "status", "completed_at"]) {
    assertEquals(cols.includes(notMoney), false, notMoney);
  }
});

Deno.test("rollback drops the trigger and both functions", () => {
  assert(rollback.includes("DROP TRIGGER IF EXISTS aa_guard_finished_trip_money_columns ON public.trips"));
  assert(rollback.includes("DROP FUNCTION IF EXISTS public.guard_finished_trip_money_columns()"));
  assert(rollback.includes("DROP FUNCTION IF EXISTS public.finished_trip_locked_money_columns()"));
});
