/**
 * Payout reliability P2 locks: running funding allowance, uncertain provider
 * responses keep the reservation, deleted drivers are never planned, immutable
 * funding snapshot before /pay, per-driver isolation, read-only reversal flags.
 * Run: deno test --allow-read supabase/tests/_shared/payoutReliabilityP2.test.ts
 */
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isUncertainPayoutSubmissionHttpStatus,
  mapProviderSubmissionOutcome,
} from "../../functions/_shared/driverPayoutSubmissionSSOT.ts";
import {
  allocateRunningPayoutFunding,
  buildPayoutFundingAttemptSnapshot,
  classifyPayoutReversalProviderState,
  shouldContinueOrchestratorMoneyPath,
  shouldReleaseReservationOnSubmitClaimFailure,
} from "../../functions/_shared/weeklyPayoutOrchestratorSSOT.ts";
import {
  evaluateDriverBatchEligibility,
  isPayoutDriverDeleted,
  isPayoutDriverHeldOrBlocked,
} from "../../functions/_shared/weeklyDriverPayoutBatchWorkflowSSOT.ts";

const ROOT = new URL("../../functions/", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, ROOT));

// ── Uncertain provider responses never release the reservation ──────────────

Deno.test("relay unreachable (status 0) → UNKNOWN, reservation kept", () => {
  const o = mapProviderSubmissionOutcome({ http_ok: false, http_status: 0, provider_payment_id: null });
  assertEquals(o.execution_status, "UNKNOWN");
  assertEquals(o.release_reservation, false);
  assertEquals(o.keep_reservation_active, true);
});

Deno.test("5xx and 408 → UNKNOWN even when flagged hard_reject", () => {
  for (const status of [500, 502, 503, 504, 408]) {
    const o = mapProviderSubmissionOutcome({ http_ok: false, http_status: status, hard_reject: true });
    assertEquals(o.execution_status, "UNKNOWN", `status ${status}`);
    assertEquals(o.release_reservation, false, `status ${status}`);
  }
});

Deno.test("relay explicitly did not call /pay → certain failure may release", () => {
  const o = mapProviderSubmissionOutcome({
    http_ok: false,
    http_status: 0,
    pay_call_explicitly_not_made: true,
    hard_reject: true,
  });
  assertEquals(o.release_reservation, true);
});

Deno.test("provider declined / failed → release (certain no-money outcome)", () => {
  const declined = mapProviderSubmissionOutcome({ http_ok: false, http_status: 502, provider_state: "declined" });
  assertEquals(declined.execution_status, "DECLINED");
  assertEquals(declined.release_reservation, true);
  const failed = mapProviderSubmissionOutcome({ http_ok: true, http_status: 200, provider_state: "failed" });
  assertEquals(failed.release_reservation, true);
});

Deno.test("definite 4xx rejection without payment id still releases", () => {
  const o = mapProviderSubmissionOutcome({ http_ok: false, http_status: 422, hard_reject: true });
  assertEquals(o.execution_status, "FAILED");
  assertEquals(o.release_reservation, true);
});

Deno.test("timeout stays UNKNOWN", () => {
  const o = mapProviderSubmissionOutcome({ http_ok: false, timed_out: true, provider_state: "declined" });
  assertEquals(o.execution_status, "UNKNOWN");
  assertEquals(o.release_reservation, false);
});

Deno.test("uncertain status classifier", () => {
  for (const s of [0, 408, 500, 599]) assertEquals(isUncertainPayoutSubmissionHttpStatus(s), true, String(s));
  for (const s of [200, 400, 401, 404, 409, 422]) assertEquals(isUncertainPayoutSubmissionHttpStatus(s), false, String(s));
});

Deno.test("SUBMISSION_IN_FLIGHT / ALREADY_SUBMITTED / UNKNOWN claim failures keep the reservation", () => {
  for (const code of ["SUBMISSION_IN_FLIGHT", "ALREADY_SUBMITTED", "UNKNOWN_NO_BLIND_RETRY"]) {
    assertEquals(shouldReleaseReservationOnSubmitClaimFailure(code), false, code);
  }
});

// ── One running funding allowance per pass ───────────────────────────────────

Deno.test("two 90p items against 100p: only one is funded", () => {
  const r = allocateRunningPayoutFunding({
    available_pence: 100,
    items: [{ key: "b", amount_pence: 90 }, { key: "a", amount_pence: 90 }],
  });
  assertEquals(r.funded_count, 1);
  assertEquals(r.remaining_pence, 10);
  const funded = r.decisions.filter((d) => d.funded);
  assertEquals(funded.map((d) => d.key), ["a"]);
  assertEquals(funded[0].remaining_before_pence, 100);
  assertEquals(funded[0].remaining_after_pence, 10);
  const skipped = r.decisions.find((d) => d.key === "b")!;
  assertEquals(skipped.funded, false);
  assertEquals(skipped.remaining_before_pence, 10);
});

Deno.test("60/30/50 against 100: smaller items funded, unaffordable large item skipped", () => {
  const r = allocateRunningPayoutFunding({
    available_pence: 100,
    items: [{ key: "x", amount_pence: 60 }, { key: "y", amount_pence: 30 }, { key: "z", amount_pence: 50 }],
  });
  const funded = r.decisions.filter((d) => d.funded).map((d) => d.key).sort();
  assertEquals(funded, ["y", "z"]);
  assertEquals(r.remaining_pence, 20);
  const total = r.decisions.filter((d) => d.funded).reduce((s, d) => s + d.amount_pence, 0);
  assert(total <= 100);
});

Deno.test("unknown balance funds nothing", () => {
  const r = allocateRunningPayoutFunding({ available_pence: null, items: [{ key: "a", amount_pence: 1 }] });
  assertEquals(r.funded_count, 0);
});

Deno.test("batch-wide shortfall does not block fundable drivers", () => {
  const base = {
    dry_run: false,
    live_enabled: true,
    transport_enabled: true,
    has_batch: true,
    fresh_eligible_count: 2,
    in_flight_item_count: 0,
    blocker_code: "INSUFFICIENT_SETTLED_FUNDS",
  };
  assertEquals(shouldContinueOrchestratorMoneyPath({ ...base, fundable_item_count: 1 }).continue, true);
  assertEquals(shouldContinueOrchestratorMoneyPath({ ...base, fundable_item_count: 0 }).continue, false);
  assertEquals(
    shouldContinueOrchestratorMoneyPath({ ...base, blocker_code: "PAYMENT_TRANSPORT_DISABLED", fundable_item_count: 2 })
      .continue,
    false,
  );
});

Deno.test("funding snapshot requires a funded decision and is frozen", () => {
  const r = allocateRunningPayoutFunding({ available_pence: 100, items: [{ key: "d1", amount_pence: 60 }, { key: "d2", amount_pence: 70 }] });
  const ok = r.decisions.find((d) => d.key === "d1")!;
  const base = {
    run_id: "run",
    schedule_occurrence_key: "occ",
    payout_item_id: "item",
    intent_id: "intent",
    driver_id: "d1",
    claim_token: "tok",
    source_account_id: "acc",
    balance_read_at: "2026-10-13T12:00:00.000Z",
    provider_available_pence: 100,
  };
  const snap = buildPayoutFundingAttemptSnapshot({ ...base, decision: ok });
  assertEquals(snap.remaining_before_pence, 100);
  assertEquals(snap.amount_pence, 60);
  assertEquals(snap.remaining_after_pence, 40);
  assert(Object.isFrozen(snap));
  const unfunded = r.decisions.find((d) => d.key === "d2")!;
  assertThrows(() => buildPayoutFundingAttemptSnapshot({ ...base, decision: unfunded }));
});

// ── Deleted drivers: never planned, never paid, records kept ─────────────────

Deno.test("deleted / held driver helpers", () => {
  assertEquals(isPayoutDriverDeleted({ driver_status: "deleted" }), true);
  assertEquals(isPayoutDriverDeleted({ driver_status: "active", deleted_at: "2026-10-01T00:00:00Z" }), true);
  assertEquals(isPayoutDriverDeleted({ driver_status: "active", deleted_at: null }), false);
  for (const s of ["disabled", "suspended", "banned", "blocked", "inactive", "held"]) {
    assertEquals(isPayoutDriverHeldOrBlocked({ driver_status: s }), true, s);
  }
  assertEquals(isPayoutDriverHeldOrBlocked({ driver_status: "active" }), false);
});

Deno.test("deleted driver is ineligible with DRIVER_DELETED", () => {
  const d = evaluateDriverBatchEligibility({
    driver_id: "mk0002",
    wallet_balance_pence: 5989,
    available_payout_pence: 5989,
    driver_held_or_blocked: false,
    driver_deleted: true,
    currency: "GBP",
    expected_currency: "GBP",
    destination: {
      id: "dest",
      is_active: true,
      provider_link_status: "PROVIDER_VERIFIED",
      provider_counterparty_id: "cp",
      provider_recipient_account_id: "ra",
    },
    has_conflicting_active_item: false,
  });
  assertEquals(d.eligible, false);
  assert(!d.eligible && d.reasons.includes("DRIVER_DELETED"));
});

// ── Reversal classification is flag-only ─────────────────────────────────────

Deno.test("reversal classifier", () => {
  for (const s of ["reverted", "REVERSED", "returned", "refunded"]) {
    assertEquals(classifyPayoutReversalProviderState(s), "REVERSED", s);
  }
  for (const s of ["failed", "declined", "cancelled", "canceled"]) {
    assertEquals(classifyPayoutReversalProviderState(s), "FAILED", s);
  }
  for (const s of ["completed", "pending", "", null]) {
    assertEquals(classifyPayoutReversalProviderState(s), null, String(s));
  }
});

// ── Source locks on the executor / scheduler ─────────────────────────────────

Deno.test("executor: funding snapshot persisted after claim and before /pay; failure aborts claim", async () => {
  const src = await read("admin-execute-weekly-payout-occurrence/index.ts");
  const claimAt = src.indexOf('"claim_driver_payout_submission"');
  const snapAt = src.indexOf('.from("driver_payout_funding_attempt_snapshots")');
  const payAt = src.indexOf("await relayApprovedDriverPayoutPayment({");
  assert(claimAt > 0 && snapAt > claimAt && payAt > snapAt, "claim → snapshot → /pay");
  const between = src.slice(snapAt, payAt);
  assert(between.includes('"abort_driver_payout_submission_claim"'));
  assert(between.includes("FUNDING_SNAPSHOT_FAILED"));
  assert(!between.includes("release_driver_payout_reservation"), "snapshot failure must not release");
  assert(between.includes("if (!fundingSnapshotOk) continue;"));
});

Deno.test("executor: per-item gate uses the running allowance, not the full balance", async () => {
  const src = await read("admin-execute-weekly-payout-occurrence/index.ts");
  assert(src.includes("allocateRunningPayoutFunding({"));
  assert(src.includes("fundable_item_count: runningFunding.funded_count"));
  assert(src.includes("fundingDecisionByDriver.get(p.driver_id)"));
  assertEquals(/required_batch_pence:\s*p\.amount_pence/.test(src), false);
});

Deno.test("executor: mapper receives http status and explicit not-called signal", async () => {
  for (const fn of [
    "admin-execute-weekly-payout-occurrence/index.ts",
    "driver-withdraw/index.ts",
    "admin-submit-driver-payout-payment/index.ts",
  ]) {
    const src = await read(fn);
    assert(src.includes("http_status: relayResult.status"), fn);
    assert(src.includes("pay_call_explicitly_not_made:"), fn);
  }
});

Deno.test("executor: each driver isolated by try/catch that keeps the reservation", async () => {
  const src = await read("admin-execute-weekly-payout-occurrence/index.ts");
  const loopAt = src.indexOf("for (const p of moneyWork) {");
  assert(loopAt > 0);
  assert(src.slice(loopAt, loopAt + 60).includes("try {"));
  const catchAt = src.indexOf("} catch (driverErr) {", loopAt);
  assert(catchAt > loopAt);
  const catchBody = src.slice(catchAt, src.indexOf("\n    }\n", catchAt));
  assert(catchBody.includes("DRIVER_ITEM_EXCEPTION"));
  assert(catchBody.includes("reservation_kept_active: true"));
  assert(!catchBody.includes("release_driver_payout_reservation"));
});

Deno.test("executor + scheduler: deleted drivers selected, skipped before planning, reported", async () => {
  for (const fn of ["admin-execute-weekly-payout-occurrence/index.ts", "admin-weekly-payout-scheduler/index.ts"]) {
    const src = await read(fn);
    assert(/driver_status, deleted_at"/.test(src), `${fn} selects deleted_at`);
    assert(src.includes("isPayoutDriverDeleted(driver)"), fn);
    assert(src.includes("isPayoutDriverHeldOrBlocked(driver)"), fn);
    assert(src.includes("deleted_drivers_held_for_review"), fn);
    assertEquals(src.includes('["suspended", "blocked", "banned", "held"]'), false, fn);
  }
});

Deno.test("executor: in-flight provider intents block a new item for the driver", async () => {
  const src = await read("admin-execute-weekly-payout-occurrence/index.ts");
  assert(src.includes('.from("driver_payout_payment_intents")'));
  assert(src.includes('["SUBMITTING", "SUBMITTED", "UNKNOWN", "PROCESSING"]'));
});

Deno.test("executor: reversal poll is read-only (flags + audit, no money writes)", async () => {
  const src = await read("admin-execute-weekly-payout-occurrence/index.ts");
  const at = src.indexOf("async function pollCompletedPayoutReversals(");
  assert(at > 0);
  const body = src.slice(at);
  assert(body.includes('"payout_provider_reversal_checks"'));
  assert(body.includes("PROVIDER_REVERSAL_DETECTED"));
  for (const forbidden of [
    "driver_wallet_ledger",
    "release_driver_payout_reservation",
    "finalize_driver_payout",
    'from("payout_items").update',
    "relayApprovedDriverPayoutPayment({",
  ]) {
    assertEquals(body.includes(forbidden), false, forbidden);
  }
});

Deno.test("migration: snapshot table append-only, reversal flag immutable, service-role only", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20261216220000_payout_reliability_p2.sql", import.meta.url),
  );
  assert(sql.includes("FUNDING_SNAPSHOT_IMMUTABLE"));
  assert(sql.includes("BEFORE UPDATE OR DELETE ON public.driver_payout_funding_attempt_snapshots"));
  assert(sql.includes("BEFORE TRUNCATE ON public.driver_payout_funding_attempt_snapshots"));
  assert(sql.includes("UNIQUE (intent_id, claim_token)"));
  assert(sql.includes("remaining_after_pence = remaining_before_pence - amount_pence"));
  assert(sql.includes("REVERSAL_FLAG_IMMUTABLE"));
  assertEquals((sql.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length, 2);
  assertEquals((sql.match(/REVOKE ALL ON public\.\w+ FROM anon, authenticated/g) ?? []).length, 2);
});
