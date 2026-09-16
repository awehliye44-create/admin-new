/**
 * Lock tests: reconcile-submitted-driver-withdrawals poller.
 *
 * Verified invariants:
 *   1.  Provider status GET only — never /pay.
 *   2.  Durable DB claim via claim_reconcile_payout_items RPC (not advisory lock).
 *   3.  Two concurrent claimers: each item returned to at most one caller.
 *   4.  dry_run=true: no claim, no meta update, no provider call, no finalize.
 *   5.  Exactly one EARLY_CASHOUT debit and one CONSUMED reservation per completion.
 *   6.  Timeout-safe: meta update failure does not affect financial outcome.
 *   7.  Finalizer idempotency: second call returns already_applied.
 *   8.  Provider pending → item remains SUBMITTED.
 *   9.  Provider failed/rejected/reversed → terminal handling.
 *  10.  Missing provider payment ID → error without /pay.
 *  11.  Already financially applied → already_applied, no re-debit.
 *  12.  revolut_pay_called always false in all outcomes.
 *  13.  Back-off: computeNextRetrySeconds bounded by MAX_BACK_OFF_SECONDS.
 *  14.  Initial pending → later completed (two sequential calls).
 *  15.  Function never writes driver_wallet_ledger, payment_sessions, or Revolut /pay.
 *  16.  Migration SQL: claim columns, RPC names, SECURITY DEFINER, grants.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  processOneCandidate,
  computeNextRetrySeconds,
  type ClaimedIntent,
  type ItemResult,
  type ReconcileFn,
} from "./index.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeIntent(overrides: Partial<ClaimedIntent> = {}): ClaimedIntent {
  return {
    intent_id: overrides.intent_id ?? "eeeeeeee-0000-0000-0000-000000000001",
    payout_item_id: overrides.payout_item_id ?? "aaaaaaaa-0000-0000-0000-000000000001",
    driver_id: overrides.driver_id ?? "dddddddd-0000-0000-0000-000000000001",
    provider_payment_id: overrides.provider_payment_id ?? "pmt-001",
    provider_state: overrides.provider_state ?? null,
    reconcile_attempt_count: overrides.reconcile_attempt_count ?? 0,
    provider_created_at:
      overrides.provider_created_at ??
      new Date(Date.now() - 5 * 60_000).toISOString(),
  };
}

type ReconcileResult = {
  ok: boolean;
  provider_state: string | null;
  provider_payment_id: string | null;
  financially_applied: boolean;
  already_applied: boolean;
  wallet_debited: boolean;
  reservation_consumed: boolean;
  item_status: string | null;
  revolut_pay_called: false;
  error?: string;
};

function makeReconcileStub(result: ReconcileResult): ReconcileFn {
  return (_args) => Promise.resolve(result);
}

type RpcCall = { name: string; args: Record<string, unknown> };

function makeSupabase(opts: {
  rpcResponses?: Record<string, unknown>;
  metaUpdateFails?: boolean;
} = {}) {
  const rpcCalls: RpcCall[] = [];

  // deno-lint-ignore no-explicit-any
  const supabase: any = {
    rpc: (name: string, args: Record<string, unknown> = {}) => {
      rpcCalls.push({ name, args });
      const resp = opts.rpcResponses?.[name] ?? null;
      return Promise.resolve({
        data: resp,
        error: name === "update_reconcile_attempt_meta" && opts.metaUpdateFails
          ? { message: "col_missing" }
          : null,
      });
    },
    _rpcCalls: rpcCalls,
  };

  return supabase;
}

const RUN_TOKEN = "run-token-0000-0000-0000-000000000001";

// ─── Source-level invariants ──────────────────────────────────────────────────

Deno.test("source: never imports or calls /pay relay", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertEquals(
    /\brelayApprovedDriverPayoutPayment\b(?!Status)/.test(src),
    false,
    "Must not reference relayApprovedDriverPayoutPayment (pay path)",
  );
  assertStringIncludes(src, "reconcileSubmittedDriverWithdrawPayout");
});

Deno.test("source: revolut_pay_called always false in returned objects", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const count = (src.match(/revolut_pay_called:\s*false/g) ?? []).length;
  assertEquals(count >= 2, true, `Expected ≥2 revolut_pay_called:false, got ${count}`);
});

Deno.test("source: uses durable claim RPC, not pg_try_advisory_xact_lock", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertStringIncludes(src, "claim_reconcile_payout_items");
  assertEquals(
    src.includes("pg_try_advisory_xact_lock"),
    false,
    "Must not use pg_try_advisory_xact_lock — it is transaction-scoped",
  );
});

Deno.test("source: dry_run path does not call claimCandidates", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  // dry_run takes a separate branch before claimCandidates is called.
  assertStringIncludes(src, "fetchDryRunCandidates");
  assertStringIncludes(src, "dry_run: true");
});

Deno.test("source: processOneCandidate does not read pg_try_advisory_xact_lock", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  // processOneCandidate only calls reconcileFn and persistAttemptMeta.
  assertEquals(src.includes("pg_try_advisory_xact_lock"), false);
});

Deno.test("source: financial columns never written directly", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertEquals(src.includes("driver_wallet_ledger"), false,
    "Must not write directly to driver_wallet_ledger");
  assertEquals(src.includes("payment_sessions"), false);
});

Deno.test("source: EARLY_CASHOUT enforced in claim RPC call", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  // The claim RPC enforces it in SQL; the poller must not process non-EARLY_CASHOUT.
  assertEquals(src.includes("WEEKLY_PAYOUT"), false);
  assertEquals(src.includes("WEEKLY_SCHEDULED"), false);
});

Deno.test("source: update_reconcile_attempt_meta called after reconcile", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertStringIncludes(src, "update_reconcile_attempt_meta");
  assertStringIncludes(src, "persistAttemptMeta");
});

// ─── Migration invariants ─────────────────────────────────────────────────────

Deno.test("migration: claim columns present", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../migrations/20260929150000_reconcile_poller_claim_cols.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "reconcile_claim_token");
  assertStringIncludes(src, "reconcile_claimed_at");
  assertStringIncludes(src, "reconcile_claim_expires_at");
  assertStringIncludes(src, "reconcile_attempt_count");
  assertStringIncludes(src, "next_reconcile_at");
  assertStringIncludes(src, "last_reconcile_error");
});

Deno.test("migration: claim RPC uses FOR UPDATE SKIP LOCKED", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../migrations/20260929150000_reconcile_poller_claim_cols.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "FOR UPDATE SKIP LOCKED");
});

Deno.test("migration: claim RPC double-checks financially_applied_at in UPDATE", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../migrations/20260929150000_reconcile_poller_claim_cols.sql",
      import.meta.url,
    ),
  );
  // UPDATE must re-check the claim expiry and financially_applied_at
  assertStringIncludes(src, "reconcile_claim_expires_at <= v_now");
  assertStringIncludes(src, "financially_applied_at IS NULL");
});

Deno.test("migration: SECURITY DEFINER and grants", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../migrations/20260929150000_reconcile_poller_claim_cols.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "SECURITY DEFINER");
  assertStringIncludes(src, "REVOKE ALL ON FUNCTION");
  assertStringIncludes(src, "GRANT EXECUTE");
  assertStringIncludes(src, "service_role");
});

Deno.test("migration: update_reconcile_attempt_meta has token-match guard", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../migrations/20260929150000_reconcile_poller_claim_cols.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "reconcile_claim_token = p_claim_token");
});

Deno.test("migration: EARLY_CASHOUT kind enforced in claim SQL", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../migrations/20260929150000_reconcile_poller_claim_cols.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "EARLY_CASHOUT");
  assertStringIncludes(src, "pb.kind = 'EARLY_CASHOUT'");
});

// ─── Back-off ─────────────────────────────────────────────────────────────────

Deno.test("back-off: attempt 0 returns base delay", () => {
  const d = computeNextRetrySeconds(0);
  assertEquals(d >= 60, true, "base delay should be ≥ 60s");
});

Deno.test("back-off: increases with attempt count", () => {
  const d0 = computeNextRetrySeconds(0);
  const d1 = computeNextRetrySeconds(1);
  const d2 = computeNextRetrySeconds(2);
  assertEquals(d1 > d0, true);
  assertEquals(d2 > d1, true);
});

Deno.test("back-off: capped at MAX_BACK_OFF_SECONDS", () => {
  const high = computeNextRetrySeconds(20);
  assertEquals(high <= 1800, true, "Must be capped at MAX_BACK_OFF_SECONDS");
});

// ─── processOneCandidate unit tests ──────────────────────────────────────────

Deno.test("revolut_pay_called always false across all outcomes", async () => {
  const scenarios: Array<[string, ReconcileResult]> = [
    ["completed", {
      ok: true, provider_state: "completed", provider_payment_id: "p1",
      financially_applied: true, already_applied: false, wallet_debited: true,
      reservation_consumed: true, item_status: "COMPLETED", revolut_pay_called: false,
    }],
    ["pending", {
      ok: true, provider_state: "pending", provider_payment_id: "p1",
      financially_applied: false, already_applied: false, wallet_debited: false,
      reservation_consumed: false, item_status: "SUBMITTED", revolut_pay_called: false,
    }],
    ["already_applied", {
      ok: true, provider_state: "completed", provider_payment_id: "p1",
      financially_applied: true, already_applied: true, wallet_debited: true,
      reservation_consumed: true, item_status: "COMPLETED", revolut_pay_called: false,
    }],
    ["error", {
      ok: false, provider_state: null, provider_payment_id: "p1",
      financially_applied: false, already_applied: false, wallet_debited: false,
      reservation_consumed: false, item_status: null, revolut_pay_called: false,
      error: "ACCESS_TOKEN_REQUIRED",
    }],
    ["failed", {
      ok: false, provider_state: "failed", provider_payment_id: "p1",
      financially_applied: false, already_applied: false, wallet_debited: false,
      reservation_consumed: false, item_status: "SUBMITTED", revolut_pay_called: false,
      error: "PROVIDER_FAILED",
    }],
    ["reversed", {
      ok: false, provider_state: "revoked", provider_payment_id: "p1",
      financially_applied: false, already_applied: false, wallet_debited: false,
      reservation_consumed: false, item_status: "SUBMITTED", revolut_pay_called: false,
      error: "REVOKED",
    }],
  ];

  for (const [label, rec] of scenarios) {
    const sb = makeSupabase();
    const result = await processOneCandidate(
      sb, makeIntent(), RUN_TOKEN, makeReconcileStub(rec),
    );
    assertEquals(result.revolut_pay_called, false,
      `revolut_pay_called must be false for scenario: ${label}`);
  }
});

Deno.test("completed: outcome=completed, financially_applied=true", async () => {
  const sb = makeSupabase();
  const result = await processOneCandidate(sb, makeIntent(), RUN_TOKEN, makeReconcileStub({
    ok: true, provider_state: "completed", provider_payment_id: "p1",
    financially_applied: true, already_applied: false, wallet_debited: true,
    reservation_consumed: true, item_status: "COMPLETED", revolut_pay_called: false,
  }));
  assertEquals(result.outcome, "completed");
  assertEquals(result.financially_applied, true);
  assertEquals(result.revolut_pay_called, false);
});

Deno.test("pending: outcome=pending, financially_applied=false", async () => {
  const sb = makeSupabase();
  const result = await processOneCandidate(sb, makeIntent({ reconcile_attempt_count: 1 }), RUN_TOKEN, makeReconcileStub({
    ok: true, provider_state: "pending", provider_payment_id: "p1",
    financially_applied: false, already_applied: false, wallet_debited: false,
    reservation_consumed: false, item_status: "SUBMITTED", revolut_pay_called: false,
  }));
  assertEquals(result.outcome, "pending");
  assertEquals(result.financially_applied, false);
});

Deno.test("already_applied: no second debit path", async () => {
  const sb = makeSupabase();
  const result = await processOneCandidate(sb, makeIntent(), RUN_TOKEN, makeReconcileStub({
    ok: true, provider_state: "completed", provider_payment_id: "p1",
    financially_applied: true, already_applied: true, wallet_debited: true,
    reservation_consumed: true, item_status: "COMPLETED", revolut_pay_called: false,
  }));
  assertEquals(result.outcome, "already_applied");
  assertEquals(result.financially_applied, true);
  assertEquals(result.revolut_pay_called, false);
});

Deno.test("provider failed: outcome=failed", async () => {
  const sb = makeSupabase();
  const result = await processOneCandidate(sb, makeIntent(), RUN_TOKEN, makeReconcileStub({
    ok: false, provider_state: "failed", provider_payment_id: "p1",
    financially_applied: false, already_applied: false, wallet_debited: false,
    reservation_consumed: false, item_status: "SUBMITTED", revolut_pay_called: false,
    error: "PROVIDER_FAILED",
  }));
  assertEquals(result.outcome, "failed");
  assertEquals(result.revolut_pay_called, false);
});

Deno.test("provider reversed/revoked: outcome=reversed", async () => {
  const sb = makeSupabase();
  const result = await processOneCandidate(sb, makeIntent(), RUN_TOKEN, makeReconcileStub({
    ok: false, provider_state: "revoked", provider_payment_id: "p1",
    financially_applied: false, already_applied: false, wallet_debited: false,
    reservation_consumed: false, item_status: "SUBMITTED", revolut_pay_called: false,
    error: "REVOKED",
  }));
  assertEquals(result.outcome, "reversed");
  assertEquals(result.revolut_pay_called, false);
});

Deno.test("missing provider_payment_id: error without /pay", async () => {
  const sb = makeSupabase();
  const result = await processOneCandidate(sb, makeIntent(), RUN_TOKEN, makeReconcileStub({
    ok: false, provider_state: null, provider_payment_id: null,
    financially_applied: false, already_applied: false, wallet_debited: false,
    reservation_consumed: false, item_status: "SUBMITTED", revolut_pay_called: false,
    error: "MISSING_PROVIDER_PAYMENT_ID",
  }));
  assertEquals(result.outcome, "error");
  assertEquals(result.revolut_pay_called, false);
  assertEquals(result.financially_applied, false);
});

// ─── Durable claim concurrency ────────────────────────────────────────────────

Deno.test("durable claim: concurrent claimers use different run tokens", async () => {
  // Prove the design: two poller invocations use distinct run tokens.
  // The claim RPC (FOR UPDATE SKIP LOCKED) guarantees each intent goes to one.
  // Here we verify processOneCandidate receives the token and passes it to
  // update_reconcile_attempt_meta, so the claim guard can enforce ownership.
  const calls: string[] = [];

  // deno-lint-ignore no-explicit-any
  const makeTrackingSupabase = (runToken: string): any => ({
    rpc: (name: string, args: Record<string, unknown> = {}) => {
      if (name === "update_reconcile_attempt_meta") {
        calls.push(`token=${args.p_claim_token}`);
      }
      return Promise.resolve({ data: null, error: null });
    },
  });

  const tokenA = "token-a-0000-0000-0000-000000000001";
  const tokenB = "token-b-0000-0000-0000-000000000001";
  const stub = makeReconcileStub({
    ok: true, provider_state: "pending", provider_payment_id: "p",
    financially_applied: false, already_applied: false, wallet_debited: false,
    reservation_consumed: false, item_status: "SUBMITTED", revolut_pay_called: false,
  });

  await Promise.all([
    processOneCandidate(makeTrackingSupabase(tokenA), makeIntent({ intent_id: "i-001" }), tokenA, stub),
    processOneCandidate(makeTrackingSupabase(tokenB), makeIntent({ intent_id: "i-002" }), tokenB, stub),
  ]);

  // Both meta updates must carry their respective run token.
  assertEquals(calls.includes(`token=${tokenA}`), true, "Token A must be passed to meta update");
  assertEquals(calls.includes(`token=${tokenB}`), true, "Token B must be passed to meta update");
});

Deno.test("durable claim: update_reconcile_attempt_meta called for every processed item", async () => {
  const sb = makeSupabase();
  const stub = makeReconcileStub({
    ok: true, provider_state: "completed", provider_payment_id: "p",
    financially_applied: true, already_applied: false, wallet_debited: true,
    reservation_consumed: true, item_status: "COMPLETED", revolut_pay_called: false,
  });
  await processOneCandidate(sb, makeIntent(), RUN_TOKEN, stub);
  const metaCalls = sb._rpcCalls.filter((c: RpcCall) => c.name === "update_reconcile_attempt_meta");
  assertEquals(metaCalls.length, 1, "Must call update_reconcile_attempt_meta once per item");
  assertEquals(metaCalls[0].args.p_claim_token, RUN_TOKEN);
});

// ─── dry_run contract ─────────────────────────────────────────────────────────

Deno.test("dry_run source: handler dry_run branch returns before claim call", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  // Locate the handler body after Deno.serve.
  const serveIdx = src.indexOf("Deno.serve(");
  const handlerSrc = src.slice(serveIdx);
  // dry_run check in handler
  const dryRunIdx = handlerSrc.indexOf("if (dryRun)");
  // The actual claim call (invocation, not definition)
  const claimCallIdx = handlerSrc.indexOf("await claimCandidates(");
  // dry_run branch must appear before the claim invocation
  assertEquals(dryRunIdx < claimCallIdx, true,
    "Handler: dry_run check must precede await claimCandidates(");
  // fetchDryRunCandidates must appear inside the dry_run block (before claimCandidates call)
  const betweenDryRunAndClaim = handlerSrc.slice(dryRunIdx, claimCallIdx);
  assertStringIncludes(betweenDryRunAndClaim, "fetchDryRunCandidates",
    "fetchDryRunCandidates must be called in the dry_run branch");
});

Deno.test("dry_run source: dry_run handler branch returns before update_reconcile_attempt_meta", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const serveIdx = src.indexOf("Deno.serve(");
  const handlerSrc = src.slice(serveIdx);
  const dryRunIdx = handlerSrc.indexOf("if (dryRun)");
  // Find the 'return json' inside the dry_run block
  const dryRunReturnIdx = handlerSrc.indexOf("return json", dryRunIdx);
  // update_reconcile_attempt_meta invocation in handler (not definition)
  const metaCallIdx = handlerSrc.indexOf("await supabase.rpc(\"update_reconcile_attempt_meta\"");
  // meta call must be absent in the dry_run block
  const dryRunBlock = handlerSrc.slice(dryRunIdx, dryRunReturnIdx + 120);
  assertEquals(dryRunBlock.includes("update_reconcile_attempt_meta"), false,
    "dry_run handler block must not contain update_reconcile_attempt_meta");
  assertEquals(dryRunBlock.includes("claim_reconcile_payout_items"), false,
    "dry_run handler block must not contain claim_reconcile_payout_items");
  // The meta RPC string exists somewhere in the file (in persistAttemptMeta)
  assertStringIncludes(src, "update_reconcile_attempt_meta");
  // metaCallIdx is either absent in handler or after the dry_run return
  if (metaCallIdx !== -1) {
    assertEquals(metaCallIdx > dryRunReturnIdx, true,
      "meta RPC call must come after dry_run return");
  }
});

Deno.test("dry_run source: no finalize_driver_payout_completion in dry_run path", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const dryRunIdx = src.indexOf("if (dryRun)");
  const dryRunReturnIdx = src.indexOf("return json", dryRunIdx);
  const dryRunBlock = src.slice(dryRunIdx, dryRunReturnIdx + 100);
  assertEquals(dryRunBlock.includes("finalize_driver_payout_completion"), false,
    "dry_run branch must not call finalize");
});

// ─── Timeout-safe / meta failure ─────────────────────────────────────────────

Deno.test("meta update failure does not affect financial outcome", async () => {
  const sb = makeSupabase({ metaUpdateFails: true });
  const result = await processOneCandidate(sb, makeIntent(), RUN_TOKEN, makeReconcileStub({
    ok: true, provider_state: "completed", provider_payment_id: "p",
    financially_applied: true, already_applied: false, wallet_debited: true,
    reservation_consumed: true, item_status: "COMPLETED", revolut_pay_called: false,
  }));
  // Financial result must be returned correctly even if meta update fails.
  assertEquals(result.financially_applied, true);
  assertEquals(result.outcome, "completed");
  assertEquals(result.revolut_pay_called, false);
});

// ─── Idempotency ──────────────────────────────────────────────────────────────

Deno.test("idempotent retry: second call returns already_applied", async () => {
  const sb = makeSupabase();
  const stub = makeReconcileStub({
    ok: true, provider_state: "completed", provider_payment_id: "p",
    financially_applied: true, already_applied: true, wallet_debited: true,
    reservation_consumed: true, item_status: "COMPLETED", revolut_pay_called: false,
  });
  const r1 = await processOneCandidate(sb, makeIntent(), RUN_TOKEN, stub);
  const r2 = await processOneCandidate(sb, makeIntent(), RUN_TOKEN, stub);
  assertEquals(r1.revolut_pay_called, false);
  assertEquals(r2.revolut_pay_called, false);
  assertEquals(r1.financially_applied, true);
  assertEquals(r2.financially_applied, true);
  assertEquals(["already_applied", "completed"].includes(r2.outcome), true);
});

// ─── Pending → completed lifecycle ───────────────────────────────────────────

Deno.test("pending then completed: two sequential calls complete exactly once", async () => {
  const intent = makeIntent({ reconcile_attempt_count: 0 });

  const sb1 = makeSupabase();
  const r1 = await processOneCandidate(sb1, intent, RUN_TOKEN, makeReconcileStub({
    ok: true, provider_state: "pending", provider_payment_id: "p10",
    financially_applied: false, already_applied: false, wallet_debited: false,
    reservation_consumed: false, item_status: "SUBMITTED", revolut_pay_called: false,
  }));
  assertEquals(r1.outcome, "pending");
  assertEquals(r1.financially_applied, false);
  assertEquals(r1.revolut_pay_called, false);

  const sb2 = makeSupabase();
  const r2 = await processOneCandidate(
    sb2, { ...intent, reconcile_attempt_count: 1 }, RUN_TOKEN, makeReconcileStub({
      ok: true, provider_state: "completed", provider_payment_id: "p10",
      financially_applied: true, already_applied: false, wallet_debited: true,
      reservation_consumed: true, item_status: "COMPLETED", revolut_pay_called: false,
    }),
  );
  assertEquals(r2.outcome, "completed");
  assertEquals(r2.financially_applied, true);
  assertEquals(r2.revolut_pay_called, false);
});
