/**
 * P6 M3 — weekly payout auto reconcile (GET-only; weekly terminal failure = report-and-leave).
 * If these fail, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_RECONCILE_BATCH_KINDS,
  isWeeklyPayoutBatchKind,
  payoutKindAllowsAutoFailRelease,
  POLLER_RECONCILE_BATCH_KINDS,
  WEEKLY_TERMINAL_FAILURE_REPORT_ONLY_ERROR,
} from "../../functions/_shared/payoutReconcileKindsSSOT.ts";
import { reconcileSubmittedDriverWithdrawPayout } from "../../functions/_shared/driverWithdrawProviderReconcile.ts";

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));
const mig = await read("../../migrations/20270302092000_p6_m3_weekly_payout_reconcile_claim.sql");
const reconcileSrc = await read("../../functions/_shared/driverWithdrawProviderReconcile.ts");
const pollerSrc = await read("../../functions/reconcile-submitted-driver-withdrawals/index.ts");
const earlyFailMig = await read("../../migrations/20261216140000_early_cashout_financial_invariant.sql");

Deno.test("kinds SSOT: poller covers EARLY_CASHOUT + both weekly kinds; default stays early-only", () => {
  assertEquals([...POLLER_RECONCILE_BATCH_KINDS].sort(), ["EARLY_CASHOUT", "WEEKLY_MONDAY", "WEEKLY_SCHEDULED"]);
  assertEquals([...DEFAULT_RECONCILE_BATCH_KINDS], ["EARLY_CASHOUT"]);
  assert(isWeeklyPayoutBatchKind("WEEKLY_MONDAY") && isWeeklyPayoutBatchKind("WEEKLY_SCHEDULED"));
  assert(!isWeeklyPayoutBatchKind("EARLY_CASHOUT"));
});

Deno.test("only EARLY_CASHOUT may auto-fail/release", () => {
  assertEquals(payoutKindAllowsAutoFailRelease("EARLY_CASHOUT"), true);
  for (const k of ["WEEKLY_SCHEDULED", "WEEKLY_MONDAY", "MANUAL_ADMIN", "", null, undefined]) {
    assertEquals(payoutKindAllowsAutoFailRelease(k as string), false);
  }
});

Deno.test("fail_submitted_early_cashout itself still rejects non-EARLY_CASHOUT (why weekly is report-only)", () => {
  assertStringIncludes(earlyFailMig, "v_batch.kind IS DISTINCT FROM 'EARLY_CASHOUT'");
  assertStringIncludes(earlyFailMig, "'NOT_EARLY_CASHOUT'");
  assertStringIncludes(earlyFailMig, "UPDATE public.payout_batches\n  SET status = 'FAILED'");
});

Deno.test("claim RPC migration: weekly kinds joined, claim/safety machinery preserved", () => {
  assertStringIncludes(mig, "pb.kind IN ('EARLY_CASHOUT', 'WEEKLY_SCHEDULED', 'WEEKLY_MONDAY')");
  assertStringIncludes(mig, "FOR UPDATE SKIP LOCKED");
  assertStringIncludes(mig, "reconcile_claim_expires_at <= v_now");
  assertStringIncludes(mig, "dppi.financially_applied_at IS NULL");
  assertStringIncludes(mig, "dppi.execution_status = 'SUBMITTED'");
  assertStringIncludes(mig, "pi.status = 'SUBMITTED'");
  assertStringIncludes(mig, "dppi.provider_payment_id IS NOT NULL");
  assertStringIncludes(mig, "SECURITY DEFINER");
  assertStringIncludes(mig, "GRANT EXECUTE ON FUNCTION public.claim_reconcile_payout_items(uuid, integer, interval, integer) TO service_role");
  assert(!/GRANT[^;]*TO (anon|authenticated|PUBLIC)/i.test(mig));
  // No money movement, no resend in the migration.
  assert(!/INSERT INTO|driver_wallet_ledger|release_driver_payout_reservation|fail_submitted/i.test(mig.replace(/--[^\n]*/g, "")));
});

Deno.test("reconcile: weekly terminal failure branch precedes and bypasses the fail/release RPC", () => {
  const guard = reconcileSrc.indexOf("!payoutKindAllowsAutoFailRelease(batchKind)");
  const rpc = reconcileSrc.indexOf("supabase.rpc(FAIL_SUBMITTED_EARLY_CASHOUT_RPC");
  assert(guard > 0 && rpc > guard, "kind guard must come before the fail RPC");
  assertStringIncludes(reconcileSrc, "WEEKLY_TERMINAL_FAILURE_REPORT_ONLY_ERROR");
  assertEquals(WEEKLY_TERMINAL_FAILURE_REPORT_ONLY_ERROR, "WEEKLY_PROVIDER_TERMINAL_FAILURE_REPORT_ONLY");
  assertStringIncludes(reconcileSrc, "allowedBatchKinds");
});

Deno.test("reconcile + poller never call /pay, never resend, never write the ledger", () => {
  for (const src of [reconcileSrc, pollerSrc]) {
    assert(!/relayApprovedDriverPayout\(/.test(src), "no payout submit relay");
    assert(!/\/pay["'`]/.test(src), "no /pay call");
    assert(!/driver_wallet_ledger/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")), "no direct ledger write");
  }
  assertStringIncludes(reconcileSrc, "relayApprovedDriverPayoutPaymentStatus");
  assertStringIncludes(reconcileSrc, '"finalize_driver_payout_completion"');
  // Existing poller lock: index.ts must not name weekly kinds (they live in the SSOT).
  assert(!pollerSrc.includes("WEEKLY_SCHEDULED") && !pollerSrc.includes("WEEKLY_PAYOUT"));
  assertStringIncludes(pollerSrc, "POLLER_RECONCILE_BATCH_KINDS");
});

// ── Behaviour with an in-memory Supabase fake ──────────────────────────────
function fakeSupabase(kind: string) {
  const rpcCalls: string[] = [];
  const item = { id: "item-1", status: "SUBMITTED", amount_pence: 5000, driver_id: "drv", completed_at: null, batch_id: "b1" };
  const intent = {
    id: "int-1",
    provider_payment_id: "pay-1",
    provider_state: "pending",
    execution_status: "SUBMITTED",
    financially_applied_at: null,
  };
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    b.select = chain;
    b.eq = chain;
    b.order = chain;
    b.limit = chain;
    b.update = chain;
    b.maybeSingle = () =>
      Promise.resolve({
        data: table === "payout_items" ? item : table === "payout_batches" ? { kind } : table === "driver_payout_payment_intents" ? intent : null,
      });
    // deno-lint-ignore no-explicit-any
    b.then = (res: any) => res({ data: null, error: null });
    return b;
  };
  return {
    rpcCalls,
    client: {
      from: builder,
      rpc: (name: string) => {
        rpcCalls.push(name);
        return Promise.resolve({ data: { ok: true }, error: null });
      },
    },
  };
}

Deno.test("behaviour: kind outside allowedBatchKinds is rejected before any provider call", async () => {
  const f = fakeSupabase("WEEKLY_SCHEDULED");
  const r = await reconcileSubmittedDriverWithdrawPayout({
    supabase: f.client,
    payoutItemId: "item-1",
    // default = EARLY_CASHOUT only (driver-withdraw edge)
  });
  assertEquals(r.ok, false);
  assertEquals(r.error, "NOT_EARLY_CASHOUT");
  assertEquals(f.rpcCalls.length, 0);
  assertEquals(r.revolut_pay_called, false);
});
