/**
 * Regression: an increment decline must not attempt a payment_sessions.status
 * value outside the payment_session_status enum (ADDITIONAL_AUTHORISATION_DECLINED
 * was rejected by Postgres and left the session silently at _PENDING).
 * The in-memory client enforces the live enum, so an invalid write fails here.
 */
import { assert, assertEquals, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { executeSameOrderIncrement } from "../../functions/_shared/executeSameOrderIncrementSSOT.ts";
import { asSupabase, InMemorySupabase, stubFetch } from "./support/inMemorySupabase.ts";

/** pg_enum labels of public.payment_session_status (production, 2026-10-02). */
const PAYMENT_SESSION_STATUS = [
  "pending_payment", "payment_authorised", "trip_created", "payment_orphaned", "failed",
  "cancelled", "authorising", "authorised_hold", "dispatching", "completed_pending_capture",
  "captured", "released", "orphan_authorisation", "payment_shortfall", "migrated_evidence",
  "legacy_unknown", "ADDITIONAL_AUTHORISATION_REQUIRED", "ADDITIONAL_AUTHORISATION_PENDING",
  "ADDITIONAL_AUTHORISATION_CONFIRMED", "CAPTURE_LIMIT_EXCEEDED", "PARTIAL_CAPTURE_ONLY",
  "PAYMENT_RECOVERY_REQUIRED", "CAPTURE_CONFIRMED", "RECOVERY_CHECKOUT_CREATED",
  "CUSTOMER_ACTION_REQUIRED", "RECOVERY_COMPLETED", "RECOVERY_DECLINED", "RECOVERY_CANCELLED",
  "RECOVERY_EXPIRED",
] as const;

const SUCCESS_STATUSES = new Set(["ADDITIONAL_AUTHORISATION_CONFIRMED", "CAPTURE_CONFIRMED", "captured", "payment_authorised"]);

const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "ord_test_enum";
const PREVIOUS = 500;
const TARGET = 800;

function order(increment: Record<string, unknown> | null) {
  return {
    id: ORDER_ID,
    state: "AUTHORISED",
    capture_mode: "manual",
    amount: PREVIOUS,
    currency: "GBP",
    payments: [{
      id: "pay_1",
      state: "AUTHORISED",
      amount: PREVIOUS,
      authorised_amount: PREVIOUS,
      payment_method: { type: "card", card_brand: "visa" },
    }],
    incremental_authorisations: increment ? [increment] : [],
  };
}

async function run(opts: {
  increment: (reference: string) => Record<string, unknown>;
  enum?: readonly string[];
}) {
  const db = new InMemorySupabase({
    tables: {
      payment_sessions: [{
        id: SESSION_ID,
        provider_order_id: ORDER_ID,
        authorised_amount_pence: PREVIOUS,
        total_authorised_amount_pence: PREVIOUS,
        captured_amount_pence: null,
        currency: "GBP",
        status: "authorised_hold",
        metadata: {},
        financial_operation_state: "IDLE",
        financial_operation_owner: null,
        financial_operation_started_at: null,
      }],
      payment_session_authorisations: [],
    },
    enums: { payment_sessions: { status: opts.enum ?? PAYMENT_SESSION_STATUS } },
  });
  let posted = false;
  let reference = "";
  const logs: Array<Record<string, unknown>> = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    try {
      const parsed = JSON.parse(String(args[0]));
      if (parsed && typeof parsed === "object") logs.push(parsed);
    } catch { /* non-JSON log line */ }
  };
  const fetchStub = stubFetch((call) => {
    if (call.method === "POST" && call.url.endsWith(`/orders/${ORDER_ID}/increment-authorisation`)) {
      posted = true;
      reference = String((call.body as Record<string, unknown>)?.reference ?? "");
      return { status: 200, body: order(opts.increment(reference)) };
    }
    if (call.method === "GET" && call.url.endsWith(`/orders/${ORDER_ID}`)) {
      return { status: 200, body: order(posted ? opts.increment(reference) : null) };
    }
    return { status: 404, body: {} };
  });
  try {
    const result = await executeSameOrderIncrement({
      supabase: asSupabase(db),
      environment: "sandbox",
      secretKey: "sk_test_fixture_not_a_secret",
      paymentSessionId: SESSION_ID,
      providerOrderId: ORDER_ID,
      requiredTotalPence: TARGET,
      currency: "GBP",
      source: "trip_modification",
      owner: "test-owner",
    });
    return {
      result,
      db,
      logs,
      row: db.rows("payment_session_authorisations")[0] as Record<string, unknown>,
      session: db.rows("payment_sessions")[0] as Record<string, unknown>,
      posts: fetchStub.calls.filter((c) => c.method === "POST").length,
    };
  } finally {
    fetchStub.restore();
    console.log = originalLog;
  }
}

Deno.test("declined increment: session status is a valid enum value, decline evidence authoritative on the row", async () => {
  const { result, db, row, session, posts } = await run({
    increment: (ref) => ({ state: "declined", reason: "insufficient_funds", old_amount: PREVIOUS, new_amount: TARGET, reference: ref }),
  });
  assertEquals(result.kind, "declined");
  assertEquals(posts, 1);
  assertEquals(db.rejectedWrites, [], "no payment_sessions write may be rejected by the enum");
  assertEquals(session.status, "ADDITIONAL_AUTHORISATION_REQUIRED");
  assertStrictEquals(SUCCESS_STATUSES.has(String(session.status)), false);
  assertEquals(row.status, "ADDITIONAL_AUTHORISATION_DECLINED");
  assertEquals(row.error_classification, "AUTHORISED_TOTAL_BELOW_TARGET");
  const meta = row.metadata as Record<string, unknown>;
  assertEquals(meta.provider_decline_reason, "insufficient_funds");
  assertEquals(meta.provider_increment_reason_field, "reason");
  assertEquals(session.authorised_amount_pence, PREVIOUS);
  assertEquals(session.total_authorised_amount_pence, PREVIOUS);
  assertEquals(session.captured_amount_pence, null);
});

Deno.test("provider_failed increment: same canonical session status, never a decline", async () => {
  const { result, db, row, session } = await run({
    increment: (ref) => ({ state: "failed", reason: "technical_error", old_amount: PREVIOUS, new_amount: TARGET, reference: ref }),
  });
  assertEquals(result.kind, "provider_failed");
  assertEquals(db.rejectedWrites, []);
  assertEquals(session.status, "ADDITIONAL_AUTHORISATION_REQUIRED");
  assertEquals(row.status, "ADDITIONAL_AUTHORISATION_FAILED_TERMINAL");
  assertEquals((row.metadata as Record<string, unknown>).provider_decline_reason, null);
  assertEquals(session.total_authorised_amount_pence, PREVIOUS);
});

Deno.test("every payment_sessions status written during a decline is an enum member", async () => {
  const { db } = await run({
    increment: (ref) => ({ state: "declined", old_amount: PREVIOUS, new_amount: TARGET, reference: ref }),
  });
  const statuses = [
    ...db.writesTo("payment_sessions", "update").map((w) => (w.values as Record<string, unknown>).status),
    ...db.rejectedWrites.filter((r) => r.table === "payment_sessions").map((r) => r.value),
  ].filter((s) => s != null);
  assert(statuses.length > 0);
  for (const s of statuses) {
    assert((PAYMENT_SESSION_STATUS as readonly string[]).includes(String(s)), `not in enum: ${s}`);
  }
});

Deno.test("a rejected failure-status write is logged, not silent", async () => {
  const withoutRequired = PAYMENT_SESSION_STATUS.filter((s) => s !== "ADDITIONAL_AUTHORISATION_REQUIRED");
  const { result, db, logs } = await run({
    increment: (ref) => ({ state: "declined", reason: "do_not_honour", old_amount: PREVIOUS, new_amount: TARGET, reference: ref }),
    enum: withoutRequired,
  });
  assertEquals(result.kind, "declined");
  assertEquals(db.rejectedWrites.length, 1);
  const logged = logs.find((l) => l.event === "increment_failure_persist_failed");
  assert(logged, "increment_failure_persist_failed must be logged");
  assertEquals(logged!.fail_kind, "declined");
  assertEquals(logged!.session_status_error, "22P02");
  assertEquals(logged!.authorisation_row_error, null);
  assertStrictEquals(JSON.stringify(logged).includes(SESSION_ID), false);
});
