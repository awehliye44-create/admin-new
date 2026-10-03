/**
 * Behavioural: executeSameOrderIncrement persists Revolut's documented
 * incremental_authorisations[].reason and keeps declined (issuer) distinct
 * from failed (technical). Revolut is stubbed at fetch; no network.
 */
import { assert, assertEquals, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { executeSameOrderIncrement } from "../../functions/_shared/executeSameOrderIncrementSSOT.ts";
import { decideFromPreauthInvokeResult } from "../../functions/_shared/tripModificationPaymentGateSSOT.ts";
import { asSupabase, InMemorySupabase, stubFetch } from "./support/inMemorySupabase.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "ord_test_increment";
const PREVIOUS = 500;
const TARGET = 800;

type IncrementFixture = Record<string, unknown> | null;

function revolutOrder(opts: { authorised: number; increment: IncrementFixture; orderAmount?: number }) {
  return {
    id: ORDER_ID,
    state: "AUTHORISED",
    capture_mode: "manual",
    amount: opts.orderAmount ?? opts.authorised,
    currency: "GBP",
    payments: [{
      id: "pay_1",
      state: "AUTHORISED",
      amount: PREVIOUS,
      authorised_amount: opts.authorised,
      payment_method: {
        type: "card",
        card_brand: "visa",
        card_last_four: "4242",
        card_bin: "424242",
        card_expiry: "12/30",
        cardholder_name: "Test Holder",
      },
    }],
    incremental_authorisations: opts.increment ? [opts.increment] : [],
  };
}

function seed() {
  return new InMemorySupabase({
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
  });
}

/**
 * initial GET → POST increment → (optional) GETs after POST.
 * `afterPost(reference)` builds the post-POST order; the reference echoes our request.
 */
async function runIncrement(opts: {
  postResponse: (reference: string) => { status: number; body: unknown };
  afterPost: (reference: string) => Record<string, unknown>;
}) {
  const db = seed();
  let posted = false;
  let reference = "";
  const fetchStub = stubFetch((call) => {
    if (call.method === "POST" && call.url.endsWith(`/orders/${ORDER_ID}/increment-authorisation`)) {
      posted = true;
      reference = String((call.body as Record<string, unknown>)?.reference ?? "");
      return opts.postResponse(reference);
    }
    if (call.method === "GET" && call.url.endsWith(`/orders/${ORDER_ID}`)) {
      return {
        status: 200,
        body: posted ? opts.afterPost(reference) : revolutOrder({ authorised: PREVIOUS, increment: null }),
      };
    }
    return { status: 404, body: { message: `unexpected ${call.method} ${call.url}` } };
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
    const row = db.rows("payment_session_authorisations")[0] as Record<string, unknown>;
    const session = db.rows("payment_sessions")[0] as Record<string, unknown>;
    const posts = fetchStub.calls.filter((c) => c.method === "POST");
    return { result, row, session, posts, db };
  } finally {
    fetchStub.restore();
  }
}

function assertNoCardData(value: unknown) {
  const json = JSON.stringify(value);
  for (const forbidden of ["4242", "424242", "12/30", "Test Holder", "sk_test_fixture", "card_last_four", "payment_method"]) {
    assertStrictEquals(json.includes(forbidden), false, `persisted evidence leaked ${forbidden}`);
  }
}

Deno.test("increment authorised: confirmed, evidence persisted, no reason invented", async () => {
  const { result, row, session, posts } = await runIncrement({
    postResponse: (ref) => ({
      status: 200,
      body: revolutOrder({
        authorised: TARGET,
        increment: { state: "authorised", old_amount: PREVIOUS, new_amount: TARGET, reference: ref },
      }),
    }),
    afterPost: () => ({}),
  });
  assertEquals(result.kind, "confirmed");
  assertEquals(result.providerConfirmedTotalPence, TARGET);
  assertEquals(posts.length, 1);
  assertEquals(row.status, "ADDITIONAL_AUTHORISATION_CONFIRMED");
  const meta = row.metadata as Record<string, unknown>;
  assertEquals(meta.provider_increment_state, "authorised");
  assertEquals(meta.provider_outcome, "authorised");
  assertEquals(meta.provider_increment_reason, null);
  assertEquals(meta.provider_decline_reason, null);
  assertEquals(meta.provider_failure_reason, null);
  const ev = meta.provider_evidence as Record<string, unknown>;
  assertEquals(ev.increment_old_amount_pence, PREVIOUS);
  assertEquals(ev.increment_new_amount_pence, TARGET);
  assertEquals(ev.requested_target_total_pence, TARGET);
  assertEquals(ev.previous_authorised_total_pence, PREVIOUS);
  assertEquals(ev.payment_authorised_amount_pence, TARGET);
  assertEquals(ev.order_state, "AUTHORISED");
  assertEquals(ev.increment_matched_by, "reference");
  assertEquals(session.total_authorised_amount_pence, TARGET);
  assertNoCardData(row);
});

Deno.test("increment declined + reason: issuer decline, reason persisted, authorised total unchanged, single POST", async () => {
  const { result, row, session, posts } = await runIncrement({
    postResponse: (ref) => ({
      status: 200,
      body: revolutOrder({
        authorised: PREVIOUS,
        increment: { state: "declined", reason: "insufficient_funds", old_amount: PREVIOUS, new_amount: TARGET, reference: ref },
      }),
    }),
    afterPost: (ref) =>
      revolutOrder({
        authorised: PREVIOUS,
        increment: { state: "declined", reason: "insufficient_funds", old_amount: PREVIOUS, new_amount: TARGET, reference: ref },
      }),
  });
  assertEquals(result.kind, "declined");
  assertEquals(result.ok, false);
  assertEquals(result.providerConfirmedTotalPence, PREVIOUS);
  assertEquals(!result.ok && result.errorClassification, "AUTHORISED_TOTAL_BELOW_TARGET");
  assertEquals(posts.length, 1);
  assertEquals(row.status, "ADDITIONAL_AUTHORISATION_DECLINED");
  assertEquals(row.error_classification, "AUTHORISED_TOTAL_BELOW_TARGET");
  const meta = row.metadata as Record<string, unknown>;
  assertEquals(meta.provider_increment_state, "declined");
  assertEquals(meta.provider_increment_reason, "insufficient_funds");
  assertEquals(meta.provider_increment_reason_field, "reason");
  assertEquals(meta.provider_decline_reason, "insufficient_funds");
  assertEquals(meta.provider_failure_reason, null);
  assertEquals(meta.fail_kind, "declined");
  const ev = meta.provider_evidence as Record<string, unknown>;
  assertEquals(ev.payment_authorised_amount_pence, PREVIOUS);
  assertEquals(ev.provider_authorised_total_pence, PREVIOUS);
  assertEquals(ev.requested_target_total_pence, TARGET);
  assert(Array.isArray(meta.provider_evidence_trail) && (meta.provider_evidence_trail as unknown[]).length >= 2);
  // Actual authorised total unchanged after decline: never raised locally.
  assertEquals(session.total_authorised_amount_pence, PREVIOUS);
  assertNoCardData(row);
});

Deno.test("increment failed + reason: technical failure, NOT classified as issuer decline", async () => {
  const failedOrder = (ref: string) =>
    revolutOrder({
      authorised: PREVIOUS,
      increment: { state: "failed", reason: "technical_error", old_amount: PREVIOUS, new_amount: TARGET, reference: ref },
    });
  const { result, row, session, posts } = await runIncrement({
    postResponse: (ref) => ({ status: 200, body: failedOrder(ref) }),
    afterPost: failedOrder,
  });
  assertEquals(result.kind, "provider_failed");
  assertEquals(!result.ok && result.errorClassification, "PROVIDER_INCREMENT_FAILED");
  assertStrictEquals(/declin/i.test(!result.ok ? result.message : ""), false);
  assertEquals(posts.length, 1);
  assertEquals(row.status, "ADDITIONAL_AUTHORISATION_FAILED_TERMINAL");
  assertEquals(row.error_classification, "PROVIDER_INCREMENT_FAILED");
  const meta = row.metadata as Record<string, unknown>;
  assertEquals(meta.provider_increment_state, "failed");
  assertEquals(meta.provider_outcome, "failed");
  assertEquals(meta.provider_failure_reason, "technical_error");
  assertEquals(meta.provider_decline_reason, null);
  assertEquals(meta.fail_kind, "provider_failed");
  assertEquals(session.total_authorised_amount_pence, PREVIOUS);
  // Fail-closed: session waits for authorisation (never raised to target).
  assertEquals(session.status, "ADDITIONAL_AUTHORISATION_REQUIRED");
  assertNoCardData(row);

  // Gate maps provider failure to reason `failed`, never `declined`.
  const gate = decideFromPreauthInvokeResult({
    success: false,
    paymentCoverageStatus: "authorization_provider_failed",
    authorisedAmountPence: PREVIOUS,
    requiredPayablePence: TARGET,
    errorCode: "PROVIDER_INCREMENT_FAILED",
  });
  assertEquals(gate.mayApply, false);
  assertEquals((gate as { reason?: string }).reason, "failed");
});

Deno.test("increment declined with missing reason: reason stays null (not inferred)", async () => {
  const declinedNoReason = (ref: string) =>
    revolutOrder({
      authorised: PREVIOUS,
      increment: { state: "declined", old_amount: PREVIOUS, new_amount: TARGET, reference: ref },
    });
  const { result, row } = await runIncrement({
    postResponse: (ref) => ({ status: 200, body: declinedNoReason(ref) }),
    afterPost: declinedNoReason,
  });
  assertEquals(result.kind, "declined");
  const meta = row.metadata as Record<string, unknown>;
  assertEquals(meta.provider_increment_state, "declined");
  assertEquals(meta.provider_increment_reason, null);
  assertEquals(meta.provider_increment_reason_field, null);
  assertEquals(meta.provider_decline_reason, null);
});

Deno.test("increment declined with legacy decline_reason only: fallback used and labelled", async () => {
  const legacy = (ref: string) =>
    revolutOrder({
      authorised: PREVIOUS,
      increment: { state: "declined", decline_reason: "legacy_code", new_amount: TARGET, reference: ref },
    });
  const { row } = await runIncrement({
    postResponse: (ref) => ({ status: 200, body: legacy(ref) }),
    afterPost: legacy,
  });
  const meta = row.metadata as Record<string, unknown>;
  assertEquals(meta.provider_increment_reason, "legacy_code");
  assertEquals(meta.provider_increment_reason_field, "decline_reason");
});

Deno.test("increment processing then declined: reason captured from same-order GET, no second POST", async () => {
  let gets = 0;
  const { result, row, session, posts } = await runIncrement({
    postResponse: (ref) => ({
      status: 200,
      body: revolutOrder({
        authorised: PREVIOUS,
        increment: { state: "processing", old_amount: PREVIOUS, new_amount: TARGET, reference: ref },
      }),
    }),
    afterPost: (ref) => {
      gets += 1;
      return revolutOrder({
        authorised: PREVIOUS,
        increment: gets < 2
          ? { state: "processing", old_amount: PREVIOUS, new_amount: TARGET, reference: ref }
          : { state: "declined", reason: "do_not_honour", old_amount: PREVIOUS, new_amount: TARGET, reference: ref },
      });
    },
  });
  assertEquals(result.kind, "declined");
  assertEquals(posts.length, 1);
  const meta = row.metadata as Record<string, unknown>;
  assertEquals(meta.provider_decline_reason, "do_not_honour");
  assertEquals(session.total_authorised_amount_pence, PREVIOUS);
});
