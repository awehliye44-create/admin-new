import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

async function read(pathFromRepoRoot: string): Promise<string> {
  const repoRoot = new URL("../../../", import.meta.url);
  return await Deno.readTextFile(new URL(pathFromRepoRoot, repoRoot));
}

const MIGRATION = "supabase/migrations/20261108200000_corporate_suspended_booking_digital_only_lock.sql";
const ROLLBACK = "supabase/migrations/rollback/rollback_20261108200000_corporate_suspended_booking_digital_only_lock.sql";

Deno.test("corporate suspension guard is INSERT-only and fails closed before dispatch", async () => {
  const sql = await read(MIGRATION);
  assertEquals(sql.includes("enforce_corporate_account_booking_guard_trg"), true);
  assertEquals(sql.includes("BEFORE INSERT ON public.trips"), true);
  assertEquals(sql.includes("BEFORE UPDATE"), false);
  assertEquals(sql.includes("CORPORATE_ACCOUNT_SUSPENDED"), true);
  assertEquals(sql.includes("CORPORATE_ACCOUNT_NOT_ACTIVE"), true);
  assertEquals(sql.includes("CORPORATE_INVOICE_PAYMENT_DISABLED"), true);
  assertEquals(sql.includes("CORPORATE_PAYMENT_METHOD_REQUIRED"), true);
  assertEquals(sql.includes("WHEN (NEW.corporate_account_id IS NOT NULL)"), true);
  assertEquals(sql.includes("GRANT EXECUTE ON FUNCTION public.corporate_new_booking_guard_decision"), false);
  assertEquals(sql.includes("GRANT EXECUTE ON FUNCTION public.enforce_corporate_new_booking_guard"), false);
  assertEquals(sql.includes("REVOKE ALL ON FUNCTION public.corporate_new_booking_guard_decision(boolean, text, text, text, text) FROM service_role"), true);
  assertEquals(sql.includes("REVOKE ALL ON FUNCTION public.enforce_corporate_new_booking_guard() FROM service_role"), true);
  assertEquals(sql.includes("get_corporate_allowed_payment_methods"), true);
  assertEquals(sql.includes("array_append"), true);
  assertEquals(sql.includes("methods || 'CARD'"), false);
  assertEquals(sql.includes("methods || 'INVOICE'"), false);
  assertEquals(sql.includes("UPDATE public.corporate_accounts"), false);
  assertEquals(sql.includes("UPDATE public.trips"), false);
  assertEquals(sql.includes("INSERT INTO public.trips"), false);
  assertEquals(sql.includes("DROP TRIGGER IF EXISTS trg_00_stamp_trip_financial_model_on_insert"), false);
  assertEquals(sql.includes("DROP TRIGGER IF EXISTS enforce_corporate_payment_methods_trg"), false);
  assertEquals(sql.includes("DROP TRIGGER IF EXISTS tr_trips_dispatch_after_insert"), false);
});

Deno.test("repaired helper never returns INVOICE and does not enforce status", async () => {
  const sql = await read(MIGRATION);
  const helperStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.get_corporate_allowed_payment_methods");
  const helper = sql.slice(helperStart);
  assertEquals(helper.includes("array_append(methods, 'CARD')"), true);
  assertEquals(helper.includes("array_append(methods, 'WALLET')"), true);
  assertEquals(helper.includes("'INVOICE'"), false);
  assertEquals(helper.includes("suspended"), false);
  assertEquals(helper.includes("payment_invoice_enabled"), false);
});

Deno.test("rollback restores the exact pre-change helper and drops only this batch", async () => {
  const sql = await read(ROLLBACK);
  assertEquals(sql.includes("DROP TRIGGER IF EXISTS enforce_corporate_account_booking_guard_trg"), true);
  assertEquals(sql.includes("DROP FUNCTION IF EXISTS public.enforce_corporate_new_booking_guard()"), true);
  assertEquals(sql.includes("DROP FUNCTION IF EXISTS public.corporate_new_booking_guard_decision(boolean, text, text, text, text)"), true);
  assertEquals(sql.includes("methods := methods || 'CARD'"), true);
  assertEquals(sql.includes("methods := methods || 'INVOICE'"), true);
  assertEquals(sql.includes("GRANT EXECUTE ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) TO authenticated"), true);
  assertEquals(sql.includes("GRANT EXECUTE ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) TO service_role"), true);
  assertEquals(sql.includes("UPDATE public.corporate_accounts"), false);
  assertEquals(sql.includes("UPDATE public.trips"), false);
});
