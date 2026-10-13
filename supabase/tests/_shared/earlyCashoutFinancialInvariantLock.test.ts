/**
 * Lock: early cash-out financial invariant.
 *
 *   gross wallet consumption = net Revolut transfer + ONECAB cash-out fee
 *
 * Fee is ONECAB revenue (CASHOUT_FEE), recognised once, never a driver balance.
 * Early cash-out never depends on weekly batch status. Reservation is settled on
 * success and released on provider failure. Enforced in the database, not the UI.
 * If these fail, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  EARLY_CASHOUT_PROVIDER_TERMINAL_FAILURE_STATES,
  earlyCashoutAmountsBalance,
  isEarlyCashoutProviderTerminalFailure,
} from "../../functions/_shared/earlyCashoutInvariantSSOT.ts";
import {
  aggregateDriverPayoutEligibility,
  type LedgerEligibilityEvidence,
} from "../../functions/_shared/driverPayoutEligibilitySSOT.ts";

const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));
const INVARIANT = "../../migrations/20261216140000_early_cashout_financial_invariant.sql";
const INVARIANT_RB = "../../migrations/rollback/rollback_20261216140000_early_cashout_financial_invariant.sql";
const RECOVERY = "../../migrations/20261216120000_payout_recovery_cashout_fee_partial_batch_stale_items.sql";
const RECOVERY_RB =
  "../../migrations/rollback/rollback_20261216120000_payout_recovery_cashout_fee_partial_batch_stale_items.sql";
const WITHDRAW = "../../functions/driver-withdraw/index.ts";
const RECONCILE = "../../functions/_shared/driverWithdrawProviderReconcile.ts";
const ELIGIBILITY = "../../functions/_shared/fetchDriverPayoutEligibility.ts";

function fnBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert(start >= 0, `${name} missing`);
  const end = sql.indexOf("$function$;", start);
  return sql.slice(start, end);
}

// Every production early cash-out (13 items, read-only audit 2026-10-13).
const PRODUCTION_EARLY_CASHOUTS = [
  { item: "36bf6207", gross: 382, net: 382, fee: 0 },
  { item: "60c626d0", gross: 2891, net: 2841, fee: 50 },
  { item: "483363f3", gross: 2919, net: 2869, fee: 50 },
  { item: "5d2fe1d3", gross: 1275, net: 1225, fee: 50 },
  { item: "5f00ba74", gross: 3319, net: 3269, fee: 50 },
  { item: "0e237504", gross: 1179, net: 1129, fee: 50 },
  { item: "4effe485", gross: 4555, net: 4505, fee: 50 },
  { item: "a1f02284", gross: 3065, net: 3015, fee: 50 },
];

Deno.test("invariant: gross = net + fee for every recorded early cash-out", () => {
  for (const c of PRODUCTION_EARLY_CASHOUTS) {
    assertEquals(
      earlyCashoutAmountsBalance({ gross_pence: c.gross, net_pence: c.net, fee_pence: c.fee }),
      true,
      c.item,
    );
  }
});

Deno.test("invariant: rejects stranded fee, double fee, zero net, negative fee, fractions", () => {
  const bad = [
    { gross_pence: 3319, net_pence: 3269, fee_pence: 0 },
    { gross_pence: 3319, net_pence: 3269, fee_pence: 100 },
    { gross_pence: 50, net_pence: 0, fee_pence: 50 },
    { gross_pence: 3219, net_pence: 3269, fee_pence: -50 },
    { gross_pence: 3319.5, net_pence: 3269.5, fee_pence: 50 },
  ];
  for (const b of bad) assertEquals(earlyCashoutAmountsBalance(b), false, JSON.stringify(b));
  assertEquals(earlyCashoutAmountsBalance({ gross_pence: 382, net_pence: 382, fee_pence: 0 }), true);
});

const CLEARED = "2026-09-10T10:00:00.000Z";
const POLICY = { now_ms: Date.parse("2026-10-13T12:00:00.000Z"), clearing_delay_hours: 27 };
const CASHED_OUT_CREDIT: LedgerEligibilityEvidence = {
  ledger_entry_id: "credit-3319",
  trip_id: "trip-3319",
  ledger_type: "TRIP_EARNING_NET",
  amount_pence: 3319,
  trip_exists: true,
  payment_session_id: "ps-3319",
  captured_amount_pence: 3419,
  canonical_driver_net_pence: 3319,
  fr_trip_status: "BALANCED",
  refunded_amount_pence: 0,
  des_present: false,
  payment_collection_model: "PLATFORM_COLLECTED",
  payment_method: "card",
  trip_status: "completed",
  completed_at: CLEARED,
  captured_at: CLEARED,
  earning_credited_at: CLEARED,
  allocated_amount_pence: 3319,
};

function strandedLivePence(live: number): number {
  const agg = aggregateDriverPayoutEligibility({
    live_balance_pence: live,
    entries: [CASHED_OUT_CREDIT],
    clearing_policy: POLICY,
  });
  assertEquals(agg.available_balance_pence, 0);
  assertEquals(agg.pending_balance_pence, 0);
  const heldUnallocated = agg.held_entries
    .filter((h) => h.hold_reason !== "SETTLEMENT_PENDING" && h.ledger_entry_id !== CASHED_OUT_CREDIT.ledger_entry_id)
    .reduce((s, h) => s + h.amount_pence, 0);
  assertEquals(heldUnallocated, 0);
  return agg.live_balance_pence - agg.available_balance_pence - agg.pending_balance_pence;
}

Deno.test("invariant: gross deduction leaves no fee as Available, Pending, Held or stranded Live", () => {
  // Credit 3319 fully cashed out: EARLY_CASHOUT −3269 + CASHOUT_FEE −50.
  assertEquals(strandedLivePence(3319 - 3269 - 50), 0);
});

Deno.test("regression: net-only debit (missing CASHOUT_FEE) strands exactly the fee in Live", () => {
  assertEquals(strandedLivePence(3319 - 3269), 50);
});

Deno.test("terminal failure states: TS SSOT matches the SQL release RPC exactly", async () => {
  const body = fnBody(await read(INVARIANT), "fail_submitted_early_cashout");
  const m = body.match(/v_state NOT IN \(([^)]*)\)/);
  assert(m, "state list missing");
  const sqlStates = m[1].split(",").map((s) => s.trim().replace(/'/g, "")).sort();
  assertEquals(sqlStates, [...EARLY_CASHOUT_PROVIDER_TERMINAL_FAILURE_STATES].sort());
  for (const s of ["completed", "pending", "created", "", "unknown"]) {
    assertEquals(isEarlyCashoutProviderTerminalFailure(s), false, s);
  }
  assertEquals(isEarlyCashoutProviderTerminalFailure(" Declined "), true);
});

Deno.test("db: amount guard fails closed before reservation and freezes submitted amounts", async () => {
  const sql = await read(INVARIANT);
  const g = fnBody(sql, "enforce_early_cashout_amount_invariant");
  assertStringIncludes(g, "IF v_kind IS DISTINCT FROM 'EARLY_CASHOUT' THEN\n    RETURN NEW;");
  assertStringIncludes(g, "IF v_fee < 0 OR v_net <= 0 OR v_gross <> v_net + v_fee THEN");
  assertStringIncludes(g, "amounts are frozen once submitted");
  assertStringIncludes(g, "IF v_status IN ('FAILED', 'CANCELLED', 'DECLINED', 'RELEASED', 'INELIGIBLE', 'INVALID_ORPHANED')");
  assert(g.indexOf("frozen once submitted") < g.indexOf("IF v_status IN ('FAILED'"), "freeze must apply to failing rows too");
  assertStringIncludes(sql, "BEFORE INSERT OR UPDATE OF amount_pence, net_driver_payout_pence, eligibility_snapshot, status, batch_id");
});

Deno.test("db: completion requires exactly net debit + one fee row, checked at COMMIT", async () => {
  const sql = await read(INVARIANT);
  assertStringIncludes(sql, "CREATE CONSTRAINT TRIGGER trg_assert_early_cashout_completion_invariant");
  assertStringIncludes(sql, "DEFERRABLE INITIALLY DEFERRED");
  const c = fnBody(sql, "assert_early_cashout_completion_invariant");
  assertStringIncludes(c, "OR v_debit <> -v_net");
  assertStringIncludes(c, "OR v_fee_sum <> -v_fee");
  assertStringIncludes(c, "v_expected_fee_rows := (v_fee > 0)::integer;");
  assertStringIncludes(c, "OR v_fee_rows <> v_expected_fee_rows THEN");
  assertStringIncludes(c, "completed without provider payment");
  assertEquals(/payout_batches[^;]*status/i.test(c.replace(/SELECT kind INTO v_kind FROM public\.payout_batches/g, "")), false);
});

Deno.test("db: provider failure releases the gross reservation, never an applied cash-out", async () => {
  const f = fnBody(await read(INVARIANT), "fail_submitted_early_cashout");
  assertStringIncludes(f, "'ALREADY_APPLIED_REQUIRES_REVERSAL_REVIEW'");
  assertStringIncludes(f, "v_intent.financially_applied_at IS NOT NULL");
  assertStringIncludes(f, "l.type IN ('EARLY_CASHOUT', 'CASHOUT_FEE')");
  assertStringIncludes(f, "'RESERVATION_ALREADY_CONSUMED'");
  assertStringIncludes(f, "public.release_driver_payout_reservation(v_res.id, NULL, v_code)");
  assertStringIncludes(f, "'EARLY_CASHOUT_PROVIDER_FAILED_RELEASED'");
  assertStringIncludes(f, "'wallet_debited', false");
  assert(f.indexOf("ALREADY_APPLIED_REQUIRES_REVERSAL_REVIEW") < f.indexOf("release_driver_payout_reservation"));
  assertEquals(/INSERT INTO public\.driver_wallet_ledger/i.test(f), false, "release RPC never writes a debit or fee");
  assertEquals(/WEEKLY_SCHEDULED/.test(f), false, "early cash-out never depends on weekly batches");
});

Deno.test("db: grants and read-only reconciliation view", async () => {
  const sql = await read(INVARIANT);
  assertStringIncludes(sql, "REVOKE ALL ON FUNCTION public.fail_submitted_early_cashout(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;");
  assertStringIncludes(sql, "WITH (security_invoker = true)");
  assertStringIncludes(sql, "REVOKE ALL ON public.early_cashout_invariant_audit FROM PUBLIC, anon, authenticated;");
  const rb = await read(INVARIANT_RB);
  for (const obj of [
    "VIEW IF EXISTS public.early_cashout_invariant_audit",
    "FUNCTION IF EXISTS public.fail_submitted_early_cashout(uuid, text, text, jsonb)",
    "TRIGGER IF EXISTS trg_assert_early_cashout_completion_invariant",
    "TRIGGER IF EXISTS trg_enforce_early_cashout_amount_invariant",
  ]) assertStringIncludes(rb, `DROP ${obj}`);
  assertEquals(/DELETE|UPDATE\s+public\./i.test(rb), false);
});

Deno.test("fee source: admin_settings only — no hard-coded 50 / 51 in the wallet summary", async () => {
  const sql = await read(RECOVERY);
  const summary = fnBody(sql, "driver_wallet_summary_ssot");
  assertEquals(summary.includes("v_early_fee bigint := 50"), false);
  assertEquals(summary.includes("v_early_minimum bigint := 51"), false);
  assertStringIncludes(summary, "v_early_fee := public.driver_early_cashout_fee_pence();");
  assertStringIncludes(summary, "v_early_minimum := public.driver_early_cashout_minimum_pence();");
  assertStringIncludes(fnBody(sql, "driver_early_cashout_fee_pence"), "s.setting_key = 'early_cashout_fee_pence'");
  const min = fnBody(sql, "driver_early_cashout_minimum_pence");
  assertStringIncludes(min, "public.driver_early_cashout_fee_pence() + 1");
  assertStringIncludes(min, "s.setting_key = 'early_cashout_min_pence'");
  const rb = await read(RECOVERY_RB);
  assertStringIncludes(rb, "DROP FUNCTION IF EXISTS public.driver_early_cashout_fee_pence();");
  const elig = await read(ELIGIBILITY);
  assertEquals(elig.includes("|| 50"), false, "explicit admin fee 0 must be honoured");
});

Deno.test("fee value: 50p set in admin_settings before the SSOT switch, corrections gated on it", async () => {
  const fee = await read("../../migrations/_draft_review_only/20261216110000_early_cashout_fee_setting_50p.sql");
  assertStringIncludes(fee, "DRAFT / REVIEW ONLY");
  assertStringIncludes(fee, "IF v_old IS DISTINCT FROM to_jsonb(0) THEN");
  assertStringIncludes(fee, "SET setting_value = to_jsonb(50)");
  assertStringIncludes(fee, "'EARLY_CASHOUT_FEE_SETTING_ALIGNED'");
  assertEquals(/driver_wallet_ledger|payout_items|INSERT INTO public\.admin_settings/.test(fee), false);
  const corrections = await read(
    "../../migrations/_draft_review_only/20261216130000_payout_recovery_historical_corrections.sql",
  );
  assertStringIncludes(corrections, "public.driver_early_cashout_fee_pence() <> 50");
  for (const paymentId of [
    "05609426-d06a-e322-0040-620084084902",
    "05610bd9-4e62-e3aa-0040-62ad77e04cd4",
    "0563f39f-f83f-e33b-0040-625e206959f1",
    "0563f3a8-94d8-e392-0040-620b3835c8fa",
  ]) assertStringIncludes(corrections, paymentId);
  assertStringIncludes(corrections, "'recovery_aborted: Revolut reconciliation match count=% (expected 4)'");
  assert(
    corrections.indexOf("Revolut reconciliation match count") <
      corrections.indexOf("INSERT INTO public.driver_wallet_ledger"),
    "Revolut match gate must run before any ledger write",
  );
  assert(
    corrections.indexOf("driver_early_cashout_fee_pence() <> 50") <
      corrections.indexOf("INSERT INTO public.driver_wallet_ledger"),
    "fee gate must run before any ledger write",
  );
});

Deno.test("driver-withdraw: invariant checked before item, reservation and Revolut call", async () => {
  const src = await read(WITHDRAW);
  const guardAt = src.indexOf("!earlyCashoutAmountsBalance({");
  const batchAt = src.indexOf('kind: "EARLY_CASHOUT",');
  const reserveAt = src.indexOf('"reserve_driver_payout_item"');
  const payAt = src.indexOf("relayResult = await relayApprovedDriverPayoutPayment({");
  assert(guardAt > 0, "guard missing");
  assert(batchAt > guardAt && (reserveAt < 0 || reserveAt > guardAt) && payAt > guardAt);
  assertStringIncludes(src, "// Provider transfer is net of withdrawal fee (SSOT: driver_receives).\n    amount_pence: providerTransferPence,");
  assertStringIncludes(src, "net_driver_payout_pence: providerTransferPence,");
  assertStringIncludes(src, "withdrawal_fee_pence: feePence,");
});

Deno.test("reconcile: terminal provider failure releases via RPC and never finalizes", async () => {
  const src = await read(RECONCILE);
  const failAt = src.indexOf("if (isEarlyCashoutProviderTerminalFailure(liveState)) {");
  const deferAt = src.indexOf('if (liveState !== "completed") {');
  const finalizeAt = src.indexOf('"finalize_driver_payout_completion"');
  assert(failAt > 0 && failAt < deferAt && deferAt < finalizeAt);
  const branch = src.slice(failAt, deferAt);
  assertStringIncludes(branch, "args.supabase.rpc(FAIL_SUBMITTED_EARLY_CASHOUT_RPC, {");
  assertStringIncludes(branch, "ok: false,");
  assertStringIncludes(branch, "wallet_debited: false,");
  assertEquals(branch.includes("finalize_driver_payout_completion"), false);
  assertEquals(/stripe/i.test(src), false);
});
