/**
 * P6 M1 — recovery starvation lock (sweep-revolut-stale-holds + capture-expired-tip-windows).
 * If these fail, fix the code — never delete or soften the lock.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildSweepRetryStamp,
  computeSweepNextRetrySeconds,
  decideSweepReconcileOnly,
  isAmbiguousFeeCaptureOutcome,
  isSweepDeferred,
  isSweepEscalated,
  isSweepResolvedOutcome,
  parseSweepRetryMeta,
  SWEEP_MAX_BACKOFF_SECONDS,
  SWEEP_RECONCILE_ONLY_MAX_ATTEMPTS,
} from "../../functions/sweep-revolut-stale-holds/lib/sweepRetryBackoffSSOT.ts";
import {
  buildProviderGetCasFilter,
  buildTipExpiryDeferral,
  buildTipExpiryDueFilter,
  computeTipExpiryNextRetrySeconds,
  isTipExpiryDeferred,
  TIP_EXPIRY_MAX_BACKOFF_SECONDS,
} from "../../functions/capture-expired-tip-windows/lib/tipExpiryRetryBackoffSSOT.ts";
import { TIP_WINDOW_PROVIDER_GET_THROTTLE_MS } from "../../functions/capture-expired-tip-windows/lib/expiredTipWindowStaleReclaimSSOT.ts";

const sweepSrc = await Deno.readTextFile(
  new URL("../../functions/sweep-revolut-stale-holds/index.ts", import.meta.url),
);
const tipSrc = await Deno.readTextFile(
  new URL("../../functions/capture-expired-tip-windows/index.ts", import.meta.url),
);
const migSrc = await Deno.readTextFile(
  new URL(
    "../../migrations/20270302090000_p6_m1_sweep_retry_and_tip_expiry_backoff.sql",
    import.meta.url,
  ),
);

// ── M1.1 SQL WHERE pushdown ────────────────────────────────────────────────
Deno.test("sweep: terminal trip + backoff filters are in SQL, not post-limit JS", () => {
  assertStringIncludes(sweepSrc, 'trips!payment_sessions_trip_id_fkey!inner');
  assertStringIncludes(sweepSrc, '.in("trips.status", TERMINAL_TRIP_STATUSES)');
  assertStringIncludes(sweepSrc, "metadata->>sweep_next_at.is.null,metadata->>sweep_next_at.lte.");
  // The old over-fetch-then-slice window must be gone.
  assert(!sweepSrc.includes("limit * 5"), "no limit*5 over-fetch window");
  assert(!sweepSrc.includes(".slice(0, limit)"), "no post-filter slice(limit)");
  assert(!/if \(!TERMINAL\.has\(status\)\) return false/.test(sweepSrc));
});

Deno.test("sweep: completed-authorised retry window filters completed trips + due rows in SQL", () => {
  assertStringIncludes(sweepSrc, '.eq("trips.status", "completed")');
  assertStringIncludes(sweepSrc, '.in("trips.payment_status", [...COMPLETED_CAPTURE_RETRY_PAYMENT_STATUSES])');
  assertStringIncludes(sweepSrc, '.lt("trips.completed_at"');
  assertStringIncludes(sweepSrc, '.eq("trips.payment_status", "captured")');
});

Deno.test("sweep: embed uses FK hint (two payment_sessions<->trips FKs => PGRST201 without it)", () => {
  assert(!/trips!inner\(/.test(sweepSrc), "unhinted trips!inner embed is ambiguous");
});

// ── M1.2 bounded backoff via payment_sessions.metadata ─────────────────────
Deno.test("backoff: exponential, hard-capped (mirrors computeNextRetrySeconds)", () => {
  assertEquals(computeSweepNextRetrySeconds(0), 300);
  assertEquals(computeSweepNextRetrySeconds(1), 600);
  assertEquals(computeSweepNextRetrySeconds(2), 1200);
  assertEquals(computeSweepNextRetrySeconds(50), SWEEP_MAX_BACKOFF_SECONDS);
  assertEquals(computeSweepNextRetrySeconds(-3), 300);
});

Deno.test("stamp: attempts +1, next_at in future, ISO UTC ms, ambiguity flag carried", () => {
  const now = Date.UTC(2027, 2, 2, 10, 0, 0);
  const s = buildSweepRetryStamp({
    priorAttempts: 2,
    nowMs: now,
    outcome: "PROVIDER_PENDING_RECONCILIATION",
    captureAmbiguous: true,
  });
  assertEquals(s.attempts, 3);
  assertEquals(s.nextAtIso, new Date(now + 1200 * 1000).toISOString());
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s.nextAtIso));
  assertEquals(s.captureAmbiguous, true);
});

Deno.test("meta parse + deferral", () => {
  const now = Date.UTC(2027, 2, 2, 10, 0, 0);
  const meta = {
    sweep_attempts: 3,
    sweep_next_at: new Date(now + 60_000).toISOString(),
    sweep_capture_ambiguous: true,
  };
  const p = parseSweepRetryMeta(meta);
  assertEquals(p.attempts, 3);
  assertEquals(p.captureAmbiguous, true);
  assertEquals(isSweepDeferred(meta, now), true);
  assertEquals(isSweepDeferred(meta, now + 61_000), false);
  assertEquals(isSweepDeferred({}, now), false);
  assertEquals(isSweepDeferred(null, now), false);
  assertEquals(isSweepEscalated(9), false);
  assertEquals(isSweepEscalated(10), true);
});

Deno.test("only resolved outcomes skip the backoff stamp", () => {
  for (const o of ["RELEASED_AND_RECONCILED", "ALREADY_RELEASED_RECONCILED", "FEE_CAPTURED_AND_REMAINDER_RELEASED"]) {
    assertEquals(isSweepResolvedOutcome(o), true);
  }
  for (const o of ["PROVIDER_PENDING_RECONCILIATION", "PROVIDER_FAILED", "SKIPPED_SAFETY_CHECK", "HOLD_PROTECTED", "LOCAL_RECONCILIATION_FAILED_AFTER_PROVIDER_SUCCESS"]) {
    assertEquals(isSweepResolvedOutcome(o), false);
  }
});

Deno.test("sweep: stamping goes through the atomic merge RPC (no read-modify-write of metadata)", () => {
  assertStringIncludes(sweepSrc, "SWEEP_STAMP_RPC");
  assertStringIncludes(migSrc, "stamp_payment_session_sweep_retry");
  assertStringIncludes(migSrc, "COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(");
  // metadata-only: the RPC must not touch status/provider_state.
  const rpc = migSrc.slice(
    migSrc.indexOf("CREATE OR REPLACE FUNCTION public.stamp_payment_session_sweep_retry"),
    migSrc.indexOf("-- C)"),
  );
  assert(!/SET\s+status\b/i.test(rpc) && !/provider_state\s*=/i.test(rpc));
  assertStringIncludes(migSrc, "TO service_role");
});

// ── M1.2 reconcile-only: never a blind capture POST ────────────────────────
Deno.test("ambiguous fee capture is flagged only for partial_capture_fee pending outcomes", () => {
  assertEquals(
    isAmbiguousFeeCaptureOutcome({
      outcome: "PROVIDER_PENDING_RECONCILIATION",
      message: "partial_capture_unconfirmed",
      decision: { provider_action: "partial_capture_fee" },
    }),
    true,
  );
  assertEquals(
    isAmbiguousFeeCaptureOutcome({
      outcome: "PROVIDER_PENDING_RECONCILIATION",
      message: "disposition_already_in_progress",
      decision: { provider_action: "partial_capture_fee" },
    }),
    false,
  );
  assertEquals(
    isAmbiguousFeeCaptureOutcome({
      outcome: "PROVIDER_PENDING_RECONCILIATION",
      message: "post_cancel_not_released",
      decision: { provider_action: "release_full" },
    }),
    false,
  );
  assertEquals(isAmbiguousFeeCaptureOutcome({ outcome: "PROVIDER_FAILED" }), false);
});

Deno.test("reconcile-only: open provider order defers (no disposer, no POST) until escalation hatch", () => {
  for (const state of ["AUTHORISED", "PENDING", "PROCESSING", "", "WHATEVER"]) {
    assertEquals(
      decideSweepReconcileOnly({ captureAmbiguous: true, attempts: 1, providerState: state }).action,
      "defer",
      `state=${state}`,
    );
  }
  for (const state of ["COMPLETED", "CANCELLED", "FAILED"]) {
    assertEquals(
      decideSweepReconcileOnly({ captureAmbiguous: true, attempts: 1, providerState: state }).action,
      "dispose",
    );
  }
  assertEquals(
    decideSweepReconcileOnly({
      captureAmbiguous: true,
      attempts: SWEEP_RECONCILE_ONLY_MAX_ATTEMPTS,
      providerState: "AUTHORISED",
    }).action,
    "dispose",
  );
  assertEquals(
    decideSweepReconcileOnly({ captureAmbiguous: false, attempts: 0, providerState: "AUTHORISED" }).action,
    "dispose",
  );
});

Deno.test("sweep: reconcile-only GET precedes the disposer and the sweep never POSTs a capture itself", () => {
  const gateIdx = sweepSrc.indexOf("decideSweepReconcileOnly({");
  const disposeIdx = sweepSrc.indexOf("await disposeTerminalTripPayment(");
  assert(gateIdx > 0 && disposeIdx > gateIdx, "reconcile-only gate must run before dispose");
  assertStringIncludes(sweepSrc, "retrieveRevolutOrder(");
  assert(!/captureRevolutOrder\(/.test(sweepSrc), "sweep must not call a capture POST directly");
  assert(!/orders\/[^"'`]*\/capture/.test(sweepSrc), "no raw order capture URL in the sweep");
});

// ── M1.3 / L2 tip provider-GET throttle ────────────────────────────────────
Deno.test("tip: candidates select includes tip_window_last_provider_get_at (confirmed bug)", () => {
  const sel = tipSrc.slice(
    tipSrc.indexOf("const { data: candidates, error: queryErr }"),
    tipSrc.indexOf("if (queryErr)"),
  );
  assertStringIncludes(sel, "tip_window_last_provider_get_at");
  assertStringIncludes(sel, "tip_window_next_attempt_at");
  assertStringIncludes(sel, "tip_window_expiry_attempt_count");
});

Deno.test("tip: GET stamp is a CAS written BEFORE the provider GET; zero rows => skip GET", () => {
  const stampIdx = tipSrc.indexOf("buildProviderGetCasFilter(casNowMs)");
  const getIdx = tipSrc.indexOf("await retrieveRevolutOrder(");
  assert(stampIdx > 0 && getIdx > stampIdx, "CAS stamp must precede retrieveRevolutOrder");
  assertStringIncludes(tipSrc, '.select("id")');
  assertStringIncludes(tipSrc, "stampedRows.length === 0");
  // The old post-GET unconditional stamp must be gone.
  const afterGet = tipSrc.slice(getIdx, getIdx + 600);
  assert(!afterGet.includes("tip_window_last_provider_get_at: nowIso"));
});

Deno.test("tip: CAS filter = null or older than the 60s throttle", () => {
  const now = Date.UTC(2027, 2, 2, 10, 0, 0);
  const f = buildProviderGetCasFilter(now);
  assertStringIncludes(f, "tip_window_last_provider_get_at.is.null");
  assertStringIncludes(
    f,
    `tip_window_last_provider_get_at.lt.${new Date(now - TIP_WINDOW_PROVIDER_GET_THROTTLE_MS).toISOString()}`,
  );
  assertEquals(TIP_WINDOW_PROVIDER_GET_THROTTLE_MS, 60_000);
});

// ── M1.4 tip shortfall deferral ────────────────────────────────────────────
Deno.test("tip: eligibility + backoff filters are in SQL WHERE (Revolut, not driver-collected, due)", () => {
  const sel = tipSrc.slice(
    tipSrc.indexOf("const { data: candidates, error: queryErr }"),
    tipSrc.indexOf("if (queryErr)"),
  );
  assertStringIncludes(sel, '.ilike("payment_provider", "revolut")');
  assertStringIncludes(sel, "financial_model.neq.DRIVER_COLLECTED_COMMISSION_WALLET");
  assertStringIncludes(sel, "buildTipExpiryDueFilter(nowIso)");
  assertStringIncludes(sel, '.order("tip_window_expires_at", { ascending: true })');
  // Driver-collected windows still get closed — via their own query.
  assertStringIncludes(tipSrc, 'eq("financial_model", "DRIVER_COLLECTED_COMMISSION_WALLET")');
});

Deno.test("tip: backoff is exponential, capped, and defers (never abandons)", () => {
  assertEquals(computeTipExpiryNextRetrySeconds(0), 30);
  assertEquals(computeTipExpiryNextRetrySeconds(1), 60);
  assertEquals(computeTipExpiryNextRetrySeconds(99), TIP_EXPIRY_MAX_BACKOFF_SECONDS);
  const now = Date.UTC(2027, 2, 2, 10, 0, 0);
  const d = buildTipExpiryDeferral({ priorAttempts: 1, nowMs: now });
  assertEquals(d.tip_window_expiry_attempt_count, 2);
  assertEquals(d.tip_window_next_attempt_at, new Date(now + 60_000).toISOString());
  assertEquals(isTipExpiryDeferred(d.tip_window_next_attempt_at, now), true);
  assertEquals(isTipExpiryDeferred(d.tip_window_next_attempt_at, now + 60_001), false);
  assertEquals(isTipExpiryDeferred(null, now), false);
  assertStringIncludes(buildTipExpiryDueFilter("X"), "tip_window_next_attempt_at.is.null");
});

Deno.test("tip: every non-confirmed failure branch stamps a deferral; success branch does not", () => {
  for (const reason of [
    "stale_recover_missing_order",
    "provider_unknown_claim_retained",
    "stale_finalize_failed",
    "stale_reclaim_denied",
    "stale_recover_error",
    "clear_claim_failed",
    "finalize_window_failed",
    "capture_not_confirmed",
    "capture_invoke_error",
    "no_provider_order",
  ]) {
    assertStringIncludes(tipSrc, `"${reason}"`);
  }
  assertStringIncludes(tipSrc, "const deferExpiryRetry");
  assertStringIncludes(tipSrc, "if (dryRun) return;");
});

Deno.test("tip migration: columns + has_work honours backoff; no money tables touched", () => {
  assertStringIncludes(migSrc, "tip_window_next_attempt_at timestamptz");
  assertStringIncludes(migSrc, "tip_window_expiry_attempt_count integer NOT NULL DEFAULT 0");
  assertStringIncludes(migSrc, "t.tip_window_next_attempt_at IS NULL OR t.tip_window_next_attempt_at <= now()");
  assert(!/driver_wallet_ledger|payout_ledger|financial_operations/i.test(migSrc));
});

Deno.test("tip: capture path unchanged — still claim → finalize-trip-and-capture, fare-only", () => {
  assertStringIncludes(tipSrc, "claimTipWindowTrigger(");
  assertStringIncludes(tipSrc, "finalizeTipWindowCaptureImmediate(");
  assertStringIncludes(tipSrc, "expiryFareOnlyTipPence(");
});
