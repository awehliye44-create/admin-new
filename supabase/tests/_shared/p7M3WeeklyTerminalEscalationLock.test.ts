/**
 * P7 M3 — weekly provider terminal failure: durable escalation (report-and-leave) + safe
 * per-item admin resolution. If these fail, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { escalateWeeklyTerminalFailure, reconcileSubmittedDriverWithdrawPayout } from "../../functions/_shared/driverWithdrawProviderReconcile.ts";
import {
  FAIL_SUBMITTED_WEEKLY_PAYOUT_ITEM_RPC,
  POLLER_RECONCILE_BATCH_KINDS,
  WEEKLY_PAYOUT_BATCH_KINDS,
  WEEKLY_PAYOUT_PROVIDER_TERMINAL_FAILURE_EVENT,
  WEEKLY_TERMINAL_FAILURE_REPORT_ONLY_ERROR,
  weeklyTerminalFailureDedupeKey,
  weeklyTerminalFailureReviewReason,
} from "../../functions/_shared/payoutReconcileKindsSSOT.ts";
import { resolveWeeklyTerminalPayoutItem } from "../../functions/admin-resolve-weekly-terminal-payout-item/lib/resolveWeeklyTerminal.ts";

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const reconcileSrc = await read("../../functions/_shared/driverWithdrawProviderReconcile.ts");
const resolveLib = await read("../../functions/admin-resolve-weekly-terminal-payout-item/lib/resolveWeeklyTerminal.ts");
const resolveIndex = await read("../../functions/admin-resolve-weekly-terminal-payout-item/index.ts");
const mig = await read("../../migrations/20270303090000_p7_m3_fail_submitted_weekly_payout_item.sql");
const migCode = mig.replace(/--[^\n]*/g, "");
const config = await read("../../config.toml");

Deno.test("event code + SSOT constants", () => {
  assertEquals(WEEKLY_PAYOUT_PROVIDER_TERMINAL_FAILURE_EVENT, "WEEKLY_PAYOUT_PROVIDER_TERMINAL_FAILURE");
  assertEquals(FAIL_SUBMITTED_WEEKLY_PAYOUT_ITEM_RPC, "fail_submitted_weekly_payout_item");
  assertEquals(weeklyTerminalFailureReviewReason("FAILED"), "WEEKLY_PAYOUT_PROVIDER_TERMINAL_FAILURE:failed");
  assertEquals(weeklyTerminalFailureDedupeKey("i1", "Failed"), "weekly_terminal:i1:failed");
});

Deno.test("reconcile: weekly branch escalates durably but stays report-and-leave", () => {
  assertStringIncludes(reconcileSrc, "escalateWeeklyTerminalFailure(");
  assertStringIncludes(reconcileSrc, "recordPaymentFinancialEvent(");
  assertStringIncludes(reconcileSrc, "WEEKLY_PAYOUT_PROVIDER_TERMINAL_FAILURE_EVENT");
  // Stamp uses ONLY existing payout_items columns, never status/failure columns.
  const fn = reconcileSrc.slice(
    reconcileSrc.indexOf("export async function escalateWeeklyTerminalFailure"),
    reconcileSrc.indexOf("export async function reconcileSubmittedDriverWithdrawPayout"),
  );
  for (const col of ["manual_review_required: true", "manual_review_reason:", "provider_status:"]) {
    assertStringIncludes(fn, col);
  }
  assertStringIncludes(fn, '.eq("status", "SUBMITTED")');
  assert(!/(?<![_a-z])status:/.test(strip(fn)), "escalation must not write status");
  for (const forbidden of ["failure_code", "rpc(", "driver_wallet_ledger", "release_driver_payout_reservation"]) {
    assert(!strip(fn).includes(forbidden), `escalation must not touch ${forbidden}`);
  }
  // Escalation sits inside the weekly guard, before the report-only return, and before the early-cashout RPC.
  const guard = reconcileSrc.indexOf("!payoutKindAllowsAutoFailRelease(batchKind)");
  const esc = reconcileSrc.indexOf("await escalateWeeklyTerminalFailure(");
  const ret = reconcileSrc.indexOf("WEEKLY_TERMINAL_FAILURE_REPORT_ONLY_ERROR,\n      message:");
  const rpc = reconcileSrc.indexOf("supabase.rpc(FAIL_SUBMITTED_EARLY_CASHOUT_RPC");
  assert(guard > 0 && esc > guard && ret > esc && rpc > ret);
  assert(!strip(reconcileSrc).includes(FAIL_SUBMITTED_WEEKLY_PAYOUT_ITEM_RPC), "reconcile never auto-fails weekly");
});

Deno.test("migration: ONE item, ONE reservation, no batch write, service_role only", () => {
  assertStringIncludes(migCode, "CREATE OR REPLACE FUNCTION public.fail_submitted_weekly_payout_item(");
  assertStringIncludes(migCode, "SECURITY DEFINER");
  assertStringIncludes(migCode, "SET search_path TO 'public'");
  assertStringIncludes(migCode, "v_kind NOT IN ('WEEKLY_SCHEDULED', 'WEEKLY_MONDAY')");
  assertStringIncludes(migCode, "'NOT_WEEKLY_PAYOUT'");
  assertStringIncludes(migCode, "'ITEM_NOT_SUBMITTED'");
  assertStringIncludes(migCode, "'ALREADY_APPLIED_REQUIRES_REVERSAL_REVIEW'");
  assertStringIncludes(migCode, "'RESERVATION_ALREADY_CONSUMED'");
  assertStringIncludes(migCode, "'NOT_TERMINAL_PROVIDER_FAILURE'");
  // One reservation, released BY ID through the existing RPC.
  assertStringIncludes(migCode, "public.release_driver_payout_reservation(v_res.id, NULL, v_code)");
  assertEquals((migCode.match(/release_driver_payout_reservation\(/g) ?? []).length, 1);
  // Never writes payout_batches / driver_wallet_ledger directly; never broad item/reservation updates.
  assert(!/UPDATE\s+public\.payout_batches/i.test(migCode), "must not write payout_batches");
  assert(!/(INSERT INTO|UPDATE)\s+public\.driver_wallet_ledger/i.test(migCode), "no direct ledger write");
  assert(!/UPDATE\s+public\.driver_payout_reservations/i.test(migCode), "release goes through the RPC only");
  for (const m of migCode.matchAll(/UPDATE\s+public\.payout_items[\s\S]*?WHERE[^;]*;/gi)) {
    assertStringIncludes(m[0], "WHERE id = v_item.id");
  }
  for (const m of migCode.matchAll(/UPDATE\s+public\.driver_payout_payment_intents[\s\S]*?WHERE[^;]*;/gi)) {
    assertStringIncludes(m[0], "WHERE id = v_intent.id");
  }
  assertStringIncludes(migCode, "REVOKE ALL ON FUNCTION public.fail_submitted_weekly_payout_item(uuid, text, text, jsonb, uuid) FROM PUBLIC, anon, authenticated");
  assertStringIncludes(migCode, "TO service_role");
  assert(!/GRANT[^;]*TO (anon|authenticated|PUBLIC)/i.test(migCode));
  // No provider access from SQL.
  assert(!/net\.http_|http_post|http_get/i.test(migCode));
});

Deno.test("Edge: admin-gated, GET-reconciles first, never /pay", () => {
  assertStringIncludes(resolveIndex, "requireAdmin(");
  assertStringIncludes(resolveIndex, 'req.method !== "POST"');
  const lib = strip(resolveLib);
  const rec = lib.indexOf("await reconcile(");
  const rpc = lib.indexOf("args.supabase.rpc(");
  assert(rec > 0 && rpc > rec, "reconcile must precede the fail RPC");
  assertStringIncludes(lib, "allowedBatchKinds: WEEKLY_PAYOUT_BATCH_KINDS");
  assertStringIncludes(lib, "WEEKLY_TERMINAL_FAILURE_REPORT_ONLY_ERROR");
  for (const src of [lib, strip(resolveIndex)]) {
    assert(!/relayApprovedDriverPayout\(/.test(src) && !/\/pay["'`]/.test(src), "no /pay");
    assert(!/driver_wallet_ledger/.test(src), "no ledger write");
  }
  assertStringIncludes(config, "[functions.admin-resolve-weekly-terminal-payout-item]");
});

// ── Behaviour ──────────────────────────────────────────────────────────────
type Rec = { table: string; op: string; payload?: unknown; filters: Record<string, unknown> };
function fake(opts: { kind: string; providerState: string; existingEvent?: boolean }) {
  const log: Rec[] = [];
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];
  const item = { id: "item-1", status: "SUBMITTED", amount_pence: 5000, driver_id: "drv", completed_at: null, batch_id: "b1" };
  const intent = { id: "int-1", provider_payment_id: "pay-1", provider_state: "pending", execution_status: "SUBMITTED", financially_applied_at: null };
  const builder = (table: string) => {
    const rec: Rec = { table, op: "select", filters: {} };
    const b: Record<string, unknown> = {};
    const chain = () => b;
    b.select = chain;
    b.order = chain;
    b.limit = chain;
    b.eq = (k: string, v: unknown) => { rec.filters[k] = v; return b; };
    b.update = (p: unknown) => { rec.op = "update"; rec.payload = p; return b; };
    b.insert = (p: unknown) => { rec.op = "insert"; rec.payload = p; log.push(rec); return Promise.resolve({ error: null }); };
    b.maybeSingle = () => {
      if (table === "payment_financial_events") return Promise.resolve({ data: opts.existingEvent ? { id: 1 } : null });
      return Promise.resolve({
        data: table === "payout_items" ? item : table === "payout_batches" ? { kind: opts.kind } : table === "driver_payout_payment_intents" ? intent : null,
      });
    };
    // deno-lint-ignore no-explicit-any
    b.then = (res: any) => { if (rec.op === "update") log.push(rec); return res({ data: null, error: null }); };
    return b;
  };
  return { log, rpcs, client: { from: builder, rpc: (name: string, a: Record<string, unknown>) => { rpcs.push({ name, args: a }); return Promise.resolve({ data: { ok: true }, error: null }); } } };
}

// The reconcile hits Revolut; stub the network + token via env-free injection of globalThis.fetch is
// not possible here, so behaviour of the escalation is exercised through the exported reconcile with
// a stubbed relay is unnecessary: we test the resolve orchestration with an injected reconcile, and the
// escalation text/ordering above. Orchestration behaviour:
function recResult(over: Record<string, unknown>) {
  return {
    ok: false,
    payout_item_id: "item-1",
    provider_payment_id: "pay-1",
    provider_payment_id_masked: "***",
    provider_state: "failed",
    previous_provider_state: "pending",
    revolut_pay_called: false as const,
    wallet_debited: false,
    reservation_consumed: false,
    item_status: "SUBMITTED",
    financially_applied: false,
    already_applied: false,
    error: WEEKLY_TERMINAL_FAILURE_REPORT_ONLY_ERROR,
    ...over,
  };
}

Deno.test("resolve: still terminal after GET → fails ONE item via the weekly RPC (never early-cashout RPC)", async () => {
  const f = fake({ kind: "WEEKLY_SCHEDULED", providerState: "failed" });
  const calls: string[] = [];
  const r = await resolveWeeklyTerminalPayoutItem({
    supabase: f.client,
    payoutItemId: "item-1",
    actorUserId: "admin-1",
    deps: {
      reconcile: (a) => {
        calls.push("reconcile");
        assertEquals(a.allowedBatchKinds, WEEKLY_PAYOUT_BATCH_KINDS);
        return Promise.resolve(recResult({}));
      },
    },
  });
  assertEquals(calls, ["reconcile"]);
  assertEquals(f.rpcs.length, 1);
  assertEquals(f.rpcs[0].name, "fail_submitted_weekly_payout_item");
  assertEquals(f.rpcs[0].args.p_payout_item_id, "item-1");
  assertEquals(f.rpcs[0].args.p_provider_payment_id, "pay-1");
  assertEquals(f.rpcs[0].args.p_provider_state, "failed");
  assertEquals(f.rpcs[0].args.p_actor_user_id, "admin-1");
  assertEquals(r.ok, true);
  assertEquals(r.outcome, "FAILED_AND_RELEASED");
  assertEquals(r.revolut_pay_called, false);
});

Deno.test("resolve: provider actually completed → reconciled, NO fail/release", async () => {
  const f = fake({ kind: "WEEKLY_SCHEDULED", providerState: "completed" });
  const r = await resolveWeeklyTerminalPayoutItem({
    supabase: f.client,
    payoutItemId: "item-1",
    actorUserId: null,
    deps: { reconcile: () => Promise.resolve(recResult({ ok: true, provider_state: "completed", error: undefined, financially_applied: true })) },
  });
  assertEquals(f.rpcs.length, 0);
  assertEquals(r.outcome, "RECONCILED_COMPLETED");
});

Deno.test("resolve: provider pending / read failure / not weekly → no mutation", async () => {
  for (const over of [
    { ok: true, provider_state: "pending", error: undefined },
    { ok: false, provider_state: null, error: "PROVIDER_STATUS_UNAVAILABLE" },
    { ok: false, provider_state: null, error: "NOT_EARLY_CASHOUT" },
  ]) {
    const f = fake({ kind: "EARLY_CASHOUT", providerState: "x" });
    const r = await resolveWeeklyTerminalPayoutItem({
      supabase: f.client,
      payoutItemId: "item-1",
      actorUserId: null,
      deps: { reconcile: () => Promise.resolve(recResult(over)) },
    });
    assertEquals(f.rpcs.length, 0);
    assertEquals(r.ok, false);
  }
});

Deno.test("resolve: RPC refusal (e.g. already applied) is surfaced, not swallowed", async () => {
  const f = fake({ kind: "WEEKLY_SCHEDULED", providerState: "failed" });
  f.client.rpc = () => Promise.resolve({ data: { ok: false, error: "ALREADY_APPLIED_REQUIRES_REVERSAL_REVIEW" }, error: null });
  const r = await resolveWeeklyTerminalPayoutItem({
    supabase: f.client,
    payoutItemId: "item-1",
    actorUserId: null,
    deps: { reconcile: () => Promise.resolve(recResult({})) },
  });
  assertEquals(r.ok, false);
  assertEquals(r.error, "ALREADY_APPLIED_REQUIRES_REVERSAL_REVIEW");
});

Deno.test("poller kinds unchanged; weekly kinds are the only ones the resolver accepts", () => {
  assertEquals([...WEEKLY_PAYOUT_BATCH_KINDS], ["WEEKLY_SCHEDULED", "WEEKLY_MONDAY"]);
  assertEquals(POLLER_RECONCILE_BATCH_KINDS.length, 3);
  assertEquals(typeof reconcileSubmittedDriverWithdrawPayout, "function");
});

Deno.test("behaviour: escalation records the durable event + stamps existing columns (item id, kind, provider_state)", async () => {
  const f = fake({ kind: "WEEKLY_SCHEDULED", providerState: "failed" });
  await escalateWeeklyTerminalFailure({
    supabase: f.client,
    payoutItemId: "item-1",
    batchKind: "WEEKLY_SCHEDULED",
    providerState: "failed",
    providerPaymentId: "pay-1234567890",
    driverId: "drv",
    amountPence: 5000,
  });
  const stamp = f.log.find((r) => r.table === "payout_items" && r.op === "update");
  assert(stamp, "payout_items stamped");
  assertEquals(stamp.payload, {
    manual_review_required: true,
    manual_review_reason: "WEEKLY_PAYOUT_PROVIDER_TERMINAL_FAILURE:failed",
    provider_status: "failed",
  });
  assertEquals(stamp.filters, { id: "item-1", status: "SUBMITTED" });
  const ev = f.log.find((r) => r.table === "payment_financial_events" && r.op === "insert");
  assert(ev, "durable event inserted");
  const row = ev.payload as Record<string, unknown>;
  assertEquals(row.event_type, "WEEKLY_PAYOUT_PROVIDER_TERMINAL_FAILURE");
  assertEquals(row.provider_response_state, "failed");
  assertEquals(row.execution_id, "weekly_terminal:item-1:failed");
  const detail = row.detail as Record<string, unknown>;
  assertEquals(detail.payout_item_id, "item-1");
  assertEquals(detail.kind, "WEEKLY_SCHEDULED");
  assertEquals(detail.provider_state, "failed");
  assertEquals(detail.auto_failed, false);
  assertEquals(detail.reservation_released, false);
  assertEquals(detail.revolut_pay_called, false);
  assert(!JSON.stringify(row).includes("pay-1234567890"), "provider payment id is masked");
  assertEquals(f.rpcs.length, 0, "no fail/release RPC from escalation");
});

Deno.test("behaviour: escalation event is de-duplicated per (item, provider_state)", async () => {
  const f = fake({ kind: "WEEKLY_MONDAY", providerState: "declined", existingEvent: true });
  await escalateWeeklyTerminalFailure({
    supabase: f.client,
    payoutItemId: "item-1",
    batchKind: "WEEKLY_MONDAY",
    providerState: "declined",
    providerPaymentId: "pay-1",
    driverId: "drv",
    amountPence: 5000,
  });
  assertEquals(f.log.filter((r) => r.table === "payment_financial_events").length, 0);
  assertEquals(f.log.filter((r) => r.table === "payout_items").length, 1, "stamp stays idempotent");
});
