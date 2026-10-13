/**
 * Lock: payout recovery 20261216 — early cash-out fee recognition, partial-batch
 * item independence, evidence-gated stale-item retirement, admin payout minimum,
 * Available-capped weekly planning, post-completion cancel guard.
 * If these fail, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));
const FORWARD = "../../migrations/20261216120000_payout_recovery_cashout_fee_partial_batch_stale_items.sql";
const ROLLBACK =
  "../../migrations/rollback/rollback_20261216120000_payout_recovery_cashout_fee_partial_batch_stale_items.sql";
const DRAFT = "../../migrations/_draft_review_only/20261216130000_payout_recovery_historical_corrections.sql";
const ORCHESTRATOR = "../../functions/admin-execute-weekly-payout-occurrence/index.ts";
const SCHEDULER = "../../functions/admin-weekly-payout-scheduler/index.ts";
const CANCEL_TRIP = "../../functions/cancel-trip/index.ts";
const FINANCE = "../../functions/admin-finance-reconciliation/index.ts";

function fnBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert(start >= 0, `${name} missing`);
  const end = sql.indexOf("$function$;", start);
  return sql.slice(start, end);
}

Deno.test("finalize: EARLY_CASHOUT writes CASHOUT_FEE so wallet consumes gross = net + fee", async () => {
  const fin = fnBody(await read(FORWARD), "finalize_driver_payout_completion");
  assertStringIncludes(fin, "'CASHOUT_FEE',\n        -ABS(v_fee)");
  assertStringIncludes(fin, "(v_net + v_fee) IS DISTINCT FROM v_item.amount_pence");
  assertStringIncludes(fin, "'FEE_AMOUNT_MISMATCH'");
  assertStringIncludes(fin, "'revenue_class', 'ONECAB_EARLY_CASHOUT_FEE'");
  assertStringIncludes(fin, "v_debit := -ABS(v_net)");
});

Deno.test("finalize: fee row is idempotent per provider payment and never back-filled on replay", async () => {
  const sql = await read(FORWARD);
  assertStringIncludes(sql, "driver_wallet_ledger_cashout_fee_provider_payout_uidx");
  assertStringIncludes(sql, "WHERE type = 'CASHOUT_FEE' AND provider_payout_id IS NOT NULL");
  const fin = fnBody(sql, "finalize_driver_payout_completion");
  assertStringIncludes(fin, "AND type = 'CASHOUT_FEE'");
  const replayReturn = fin.indexOf("IF v_existing_ledger IS NOT NULL AND v_res.status = 'CONSUMED' THEN");
  const feeInsert = fin.indexOf("IF v_fee > 0 THEN");
  assert(replayReturn > 0 && feeInsert > replayReturn, "already-applied return must precede the fee write");
  assertEquals(fin.includes("v_fee_ledger_id UUID;"), true);
});

Deno.test("finalize: mismatch guard returns before any ledger write", async () => {
  const fin = fnBody(await read(FORWARD), "finalize_driver_payout_completion");
  const guard = fin.indexOf("'FEE_AMOUNT_MISMATCH'");
  const firstInsert = fin.indexOf("INSERT INTO public.driver_wallet_ledger");
  assert(guard > 0 && guard < firstInsert);
});

Deno.test("reserve: PARTIALLY_COMPLETED batch reservable; item guards preserved", async () => {
  const res = fnBody(await read(FORWARD), "reserve_driver_payout_item");
  assertStringIncludes(res, "'PROCESSING',\n    'PARTIALLY_COMPLETED'\n  ) THEN");
  assertStringIncludes(res, "'COMPLETED', 'CANCELLED', 'CANCELED', 'FAILED', 'FAILED_PERMANENT', 'FAILED_TERMINAL', 'REVERSED'");
  assertStringIncludes(res, "'PAID', 'COMPLETED', 'SUBMITTED', 'SUBMITTING', 'SENT', 'CANCELLED', 'REVERSED', 'PROCESSING'");
  assertStringIncludes(res, "'PROVIDER_INTENT_EXISTS'");
  assertStringIncludes(res, "'ACTIVE_RESERVATION_EXISTS'");
  assertStringIncludes(res, "'INSUFFICIENT_AVAILABLE_WALLET'");
  assertStringIncludes(res, "driver_effective_payout_allowed");
  assertStringIncludes(res, "assert_payout_item_ledger_lineage");
  assertStringIncludes(res, "FINANCIAL_MODEL_VIOLATION");
  assertStringIncludes(res, "PROVIDER_LINK_NOT_VERIFIED");
  assertEquals(
    /kind IS DISTINCT FROM 'WEEKLY_SCHEDULED'\s*\n\s*AND v_batch\.kind IS DISTINCT FROM 'EARLY_CASHOUT'/.test(res),
    true,
  );
  assertEquals(res.includes("DISTINCT FROM 'WEEKLY_MONDAY'"), false);
});

Deno.test("retire: evidence-gated, never moves money, audited", async () => {
  const sql = await read(FORWARD);
  const fn = fnBody(sql, "retire_unsubmitted_payout_item");
  for (const code of [
    "'PROVIDER_INTENT_EXISTS'",
    "'RESERVATION_EXISTS'",
    "'PROVIDER_TRACE_EXISTS'",
    "'LEDGER_ENTRY_REFERENCES_ITEM'",
    "'RECENTLY_ACTIVE'",
    "'NOT_RETIRABLE_STATUS'",
    "'NOT_WEEKLY_SCHEDULED_ITEM'",
    "'REASON_REQUIRED'",
  ]) {
    assertStringIncludes(fn, code);
  }
  assertStringIncludes(fn, "v_status NOT IN ('CREATED', 'VALIDATED', 'BLOCKED_EXECUTION_DISABLED')");
  assertStringIncludes(fn, "failure_code = 'STALE_NEVER_SUBMITTED'");
  assertStringIncludes(fn, "INSERT INTO public.payout_audit_log");
  assertEquals(fn.includes("INSERT INTO public.driver_wallet_ledger"), false);
  assertEquals(fn.includes("INSERT INTO public.driver_payout_payment_intents"), false);
  assertEquals(fn.includes("driver_payout_reservations (\n"), false);
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.retire_unsubmitted_payout_item(uuid, text, text, boolean) TO service_role;");
  assertStringIncludes(sql, "REVOKE ALL ON FUNCTION public.retire_unsubmitted_payout_item(uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;");
});

Deno.test("summary: minimum comes from admin_settings.payout_min_pence, never hard-coded 2000", async () => {
  const sql = await read(FORWARD);
  const summary = fnBody(sql, "driver_wallet_summary_ssot");
  assertEquals(summary.includes("v_minimum bigint := 2000"), false);
  assertStringIncludes(summary, "v_minimum := public.driver_payout_minimum_pence();");
  assertStringIncludes(fnBody(sql, "driver_payout_minimum_pence"), "s.setting_key = 'payout_min_pence'");
  // Zero Available is never ELIGIBLE, even with a 0 minimum.
  const notEligible = summary.indexOf("ELSIF v_available <= 0 THEN");
  const eligible = summary.indexOf("ELSIF v_available >= v_minimum THEN");
  assert(notEligible > 0 && notEligible < eligible);
});

Deno.test("rollback restores prior bodies and drops new objects", async () => {
  const rb = await read(ROLLBACK);
  assertStringIncludes(rb, "DROP FUNCTION IF EXISTS public.retire_unsubmitted_payout_item(uuid, text, text, boolean);");
  assertStringIncludes(rb, "DROP FUNCTION IF EXISTS public.driver_payout_minimum_pence();");
  assertStringIncludes(rb, "DROP INDEX IF EXISTS public.driver_wallet_ledger_cashout_fee_provider_payout_uidx;");
  assertStringIncludes(rb, "v_minimum bigint := 2000;");
  assertEquals(rb.includes("'PARTIALLY_COMPLETED'"), false);
});

Deno.test("historical corrections are review-only, additive and never touch MK-260923-017", async () => {
  const draft = await read(DRAFT);
  assertStringIncludes(draft, "DRAFT / REVIEW ONLY — DO NOT APPLY");
  assertStringIncludes(draft, "'dw_fin_repair:cashout_fee:' || pi.id::text");
  assertStringIncludes(draft, "ON CONFLICT DO NOTHING");
  assertEquals(/\bDELETE\b/i.test(draft), false);
  assertEquals(/UPDATE\s+public\.driver_wallet_ledger/i.test(draft), false);
  assertEquals(/UPDATE\s+public\.trips/i.test(draft), false);
  const executable = draft.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  // Owner-approved scope: four CASHOUT_FEE rows (MK0006 x3, MK0007 x1), fee only.
  // MK0007 item: fee precondition, Revolut reconciliation gate, insert, postcondition.
  assertEquals((executable.match(/a1f02284-5ea5-4754-87c3-87aaa2c65391/g) ?? []).length, 4);
  assertStringIncludes(executable, "fee precondition count=% (expected 4)");
  assertStringIncludes(executable, "IF v_n <> 4 THEN");
  assertEquals(/retire_unsubmitted_payout_item\(\s*'a1f02284/.test(executable), false);
  assertEquals(/MK-260923-017|trip_cancel|financial_outcome\s*=/.test(executable), false);
  // Not discoverable as a migration.
  let inRoot = false;
  try {
    await Deno.stat(new URL("../../migrations/20261216130000_payout_recovery_historical_corrections.sql", import.meta.url));
    inRoot = true;
  } catch {
    inRoot = false;
  }
  assertEquals(inRoot, false);
});

Deno.test("orchestrator: weekly amount capped by wallet Available + admin minimum", async () => {
  const src = await read(ORCHESTRATOR);
  assertStringIncludes(src, "scoped_amount_pence: periodScope.amount_pence,");
  assertStringIncludes(src, "wallet_available_pence: eligibility.available_balance_pence,");
  assertStringIncludes(src, "minimum_payout_pence: controlCentre.payout_min_pence,");
  const capAt = src.indexOf("const scoped = { ...periodScope, amount_pence: payable.amount_pence };");
  const planAt = src.indexOf("available_balance_pence: scoped.amount_pence,");
  assert(capAt > 0, "period scope must be capped by wallet Available");
  assert(planAt > capAt, "plan must be sized from the capped period scope");
  assertEquals(src.includes("available_balance_pence: eligibility.available_balance_pence"), false);
  assertEquals(src.includes("available_balance_pence: periodScope.amount_pence"), false);
});

Deno.test("orchestrator: stale items go through the evidence-gated RPC, failures keep blocking", async () => {
  const src = await read(ORCHESTRATOR);
  assertStringIncludes(src, "isStaleUnsubmittedWeeklyItemCandidate(");
  assertStringIncludes(src, "supabase.rpc(STALE_UNSUBMITTED_RETIRE_RPC");
  assertStringIncludes(src, "p_dry_run: dryRun,");
  assertStringIncludes(src, "if (retiredOk) continue;\n      }\n      conflictDrivers.add(String(item.driver_id));");
});

Deno.test("scheduler: admin minimum + Available cap", async () => {
  const src = await read(SCHEDULER);
  assertStringIncludes(src, "minimum_payout_pence: controlCentre.payout_min_pence,");
  assertStringIncludes(src, "wallet_available_pence: eligibility.available_balance_pence,");
  assertStringIncludes(src, "\"BELOW_MIN_PAYOUT\"");
  assertEquals(src.includes("payout_min_pence ?? 2000"), false);
});

Deno.test("cancel-trip: a completed journey can never be cancelled (MK-260923-017)", async () => {
  const src = await read(CANCEL_TRIP);
  assertStringIncludes(src, "if (trip.completed_at) {");
  assertStringIncludes(src, ".is(\"completed_at\", null)");
  assertStringIncludes(src, ".not(\"status\", \"in\", `(${terminalStatuses.join(\",\")})`)");
});

Deno.test("profit SSOT: cash-out fee recognised once from CASHOUT_FEE ledger", async () => {
  const src = await read(FINANCE);
  assertStringIncludes(src, ".eq(\"type\", \"CASHOUT_FEE\")");
  assertStringIncludes(src, "netCommission + early_cashout_fee_revenue_pence");
  assertStringIncludes(src, "early_cashout_fee_revenue_pence,");
  assertStringIncludes(src, "net_commission_pence: om.onecab_net_commission_pence ?? null,");
});

Deno.test("no Stripe tokens introduced", async () => {
  for (const p of [FORWARD, ROLLBACK, DRAFT, ORCHESTRATOR, SCHEDULER, CANCEL_TRIP, FINANCE]) {
    const src = (await read(p)).toLowerCase();
    assertEquals(src.includes("stripe"), false, p);
  }
});
