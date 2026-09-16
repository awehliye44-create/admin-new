/**
 * Step 8.2A.3 — atomic refund RPC migration + wiring locks.
 *
 * Run:
 *   deno test --allow-read supabase/functions/_shared/providerRefundAtomicRpcLock.test.ts
 */
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20260930150000_provider_refund_ledger_idempotency.sql",
  import.meta.url,
);
const ROLLBACK = new URL(
  "../../migrations/rollback/rollback_20260930150000_provider_refund_ledger_idempotency.sql",
  import.meta.url,
);
const APPLY_SRC = new URL("./applyProviderRefund.ts", import.meta.url);
const ADMIN_SRC = new URL("../admin-refund-trip-payment/index.ts", import.meta.url);

Deno.test("migration adds provider_refund_id and payment_provider on driver_wallet_ledger", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert(sql.includes("ADD COLUMN IF NOT EXISTS provider_refund_id text"));
  assert(sql.includes("ADD COLUMN IF NOT EXISTS payment_provider text"));
});

Deno.test("migration enforces REFUND_DEBIT lineage unique index", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert(sql.includes("driver_wallet_ledger_refund_debit_provider_refund_unique"));
  assert(sql.includes("WHERE type = 'REFUND_DEBIT'"));
  assert(sql.includes("AND provider_refund_id IS NOT NULL"));
  assert(sql.includes("(payment_provider, provider_refund_id, driver_id)"));
});

Deno.test("migration drops unique_trip_ledger_entry and adds typed partial singleton indexes", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert(sql.includes("DROP CONSTRAINT IF EXISTS unique_trip_ledger_entry"));
  assert(sql.includes("driver_wallet_ledger_platform_commission_unique"));
  assert(sql.includes("driver_wallet_ledger_refund_debit_null_lineage_trip_unique"));
  assert(sql.includes("PREFLIGHT FAILED"));
});

Deno.test("unique_violation handler re-raises unrelated violations", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert(sql.includes("WHEN unique_violation THEN"));
  assert(sql.includes("recovered_from", false) || sql.includes("'recovered_from'"));
  assert(sql.includes("RAISE;"));
  assert(!sql.includes("RETURN jsonb_build_object(\n      'status', 'already_applied',\n      'trip_id', p_trip_id,\n      'provider_refund_id', p_provider_refund_id,\n      'error_code', 'unique_violation'"));
});

Deno.test("migration creates payment_session_refunds provider idempotency index", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert(sql.includes("payment_session_refunds_provider_refund_unique"));
  assert(sql.includes("(payment_provider, provider_refund_id)"));
});

Deno.test("RPC is SECURITY DEFINER with fixed search_path and service_role grant only", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert(sql.includes("apply_confirmed_provider_refund_atomic"));
  assert(sql.includes("SECURITY DEFINER"));
  assert(sql.includes("SET search_path = pg_catalog"));
  assert(sql.includes("REVOKE ALL ON FUNCTION public.apply_confirmed_provider_refund_atomic"));
  assert(sql.includes("FROM PUBLIC, anon, authenticated"));
  assert(sql.includes("GRANT EXECUTE ON FUNCTION public.apply_confirmed_provider_refund_atomic"));
  assert(sql.includes("TO service_role"));
  assertFalse(sql.toLowerCase().includes("execute format("));
  assertFalse(sql.toLowerCase().includes("dynamic sql"));
});

Deno.test("RPC never calls provider APIs and uses schema-qualified financial tables", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assertFalse(/\brefundRevolutOrder\b/i.test(sql));
  assertFalse(/\bapi\.revolut\b/i.test(sql));
  assert(sql.includes("public.trips"));
  assert(sql.includes("public.payment_sessions"));
  assert(sql.includes("public.payment_session_refunds"));
  assert(sql.includes("public.driver_wallet_ledger"));
  assert(sql.includes("public.payments"));
  assert(sql.includes("public.trip_finance"));
});

Deno.test("RPC fails closed on historical NULL provider_refund_id debits", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert(sql.includes("HISTORICAL_REFUND_DEBIT_REQUIRES_MANUAL_RECONCILIATION"));
  assert(sql.includes("provider_refund_id IS NULL"));
});

Deno.test("rollback refuses when non-NULL provider_refund_id ledger rows exist", async () => {
  const sql = await Deno.readTextFile(ROLLBACK);
  assert(sql.includes("ROLLBACK REFUSED"));
  assert(sql.includes("provider_refund_id IS NOT NULL"));
  assert(sql.includes("DROP FUNCTION IF EXISTS public.apply_confirmed_provider_refund_atomic"));
  assertFalse(sql.toLowerCase().includes("delete from public.driver_wallet_ledger"));
});

Deno.test("applyProviderRefund uses atomic RPC — never direct REFUND_DEBIT insert", async () => {
  const src = await Deno.readTextFile(APPLY_SRC);
  assert(src.includes("apply_confirmed_provider_refund_atomic"));
  assertFalse(src.includes('.from("driver_wallet_ledger").insert'));
  assertFalse(src.includes("upsertPaymentSessionRefund"));
  assertFalse(src.includes("refundDebitDescriptionForProviderRefund"));
  assertFalse(src.includes('.eq("description", refundDebitDescription)'));
});

Deno.test("admin-refund distinguishes provider vs local failure and sets retry_provider_refund", async () => {
  const src = await Deno.readTextFile(ADMIN_SRC);
  assert(src.includes("failure_stage"));
  assert(src.includes("retry_provider_refund: false"));
  assert(src.includes("retry_provider_refund: true"));
  assert(src.includes("failure_stage: \"local_application\""));
  assert(src.includes("failure_stage: \"provider_refund\""));
  assert(src.includes("providerRefundId"));
  assertFalse(src.includes('.from("driver_wallet_ledger")'));
});
