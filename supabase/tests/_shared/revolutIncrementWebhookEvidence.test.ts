/**
 * Behavioural: ORDER_INCREMENTAL_AUTHORISATION_* webhooks are persisted as
 * evidence, idempotently, and never mutate money (session amounts/status, trips).
 */
import { assert, assertEquals, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleRevolutIncrementWebhookEvidence } from "../../functions/_shared/revolutIncrementWebhookEvidence.ts";
import { ONECAB_REVOLUT_WEBHOOK_EVENTS } from "../../functions/_shared/revolutWebhooks.ts";
import type { RevolutIncrementWebhookEvent } from "../../functions/_shared/revolutIncrementEvidenceSSOT.ts";
import type { RevolutOrder } from "../../functions/_shared/revolutOrders.ts";
import { asSupabase, InMemorySupabase } from "./support/inMemorySupabase.ts";

const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const TRIP_ID = "33333333-3333-4333-8333-333333333333";
const ORDER_ID = "ord_webhook_test";
const REF = "inc:22222222:ord_webhook_test:800";

function seed() {
  return new InMemorySupabase({
    uniques: { processed_revolut_events: ["event_id"] },
    tables: {
      payment_sessions: [{
        id: SESSION_ID,
        trip_id: TRIP_ID,
        provider_order_id: ORDER_ID,
        status: "authorised_hold",
        total_authorised_amount_pence: 500,
        created_at: "2026-10-01T00:00:00.000Z",
      }],
      payment_session_authorisations: [{
        id: "auth-row-1",
        payment_session_id: SESSION_ID,
        provider_order_id: ORDER_ID,
        idempotency_key: REF,
        requested_target_total_pence: 800,
        status: "ADDITIONAL_AUTHORISATION_PENDING",
        metadata: { reason: "trip_modification", provider_outcome: "unsettled" },
      }],
      trips: [{ id: TRIP_ID, status: "in_progress", payment_status: "authorised" }],
      processed_revolut_events: [],
      admin_payment_audit: [],
    },
  });
}

function orderWith(increment: Record<string, unknown>, authorised = 500): RevolutOrder {
  return {
    id: ORDER_ID,
    state: "AUTHORISED",
    amount: authorised,
    currency: "GBP",
    payments: [{
      id: "pay_1",
      state: "AUTHORISED",
      amount: 500,
      authorised_amount: authorised,
      payment_method: { type: "card", card_last_four: "4242", card_bin: "424242" },
    }],
    incremental_authorisations: [{ old_amount: 500, new_amount: 800, reference: REF, ...increment }],
  } as unknown as RevolutOrder;
}

async function deliver(db: InMemorySupabase, event: RevolutIncrementWebhookEvent, order: RevolutOrder | Error) {
  return await handleRevolutIncrementWebhookEvidence({
    supabase: asSupabase(db),
    eventName: event,
    orderId: ORDER_ID,
    merchantOrderExtRef: `trip:${TRIP_ID}`,
    requestTimestamp: String(Date.now()),
    retrieveOrder: () => (order instanceof Error ? Promise.reject(order) : Promise.resolve(order)),
    nowIso: "2026-10-02T12:00:00.000Z",
  });
}

function assertNoMoneyMutation(db: InMemorySupabase) {
  assertEquals(db.writesTo("payment_sessions").length, 0, "webhook must not write payment_sessions");
  assertEquals(db.writesTo("trips").length, 0, "webhook must not write trips");
  const session = db.rows("payment_sessions")[0];
  assertEquals(session.total_authorised_amount_pence, 500);
  assertEquals(session.status, "authorised_hold");
  const row = db.rows("payment_session_authorisations")[0];
  assertEquals(row.status, "ADDITIONAL_AUTHORISATION_PENDING", "increment row status owned by SSOT only");
}

function assertNoCardData(db: InMemorySupabase) {
  const json = JSON.stringify(db.tables);
  for (const forbidden of ["4242", "424242", "card_last_four", "payment_method"]) {
    assertStrictEquals(json.includes(forbidden), false, `persisted ${forbidden}`);
  }
}

Deno.test("webhook subscription includes the three increment events", () => {
  for (const e of [
    "ORDER_INCREMENTAL_AUTHORISATION_AUTHORISED",
    "ORDER_INCREMENTAL_AUTHORISATION_DECLINED",
    "ORDER_INCREMENTAL_AUTHORISATION_FAILED",
  ]) {
    assert((ONECAB_REVOLUT_WEBHOOK_EVENTS as readonly string[]).includes(e), `${e} not subscribed`);
  }
});

Deno.test("revolut-webhook routes increment events to evidence handler before order lifecycle", async () => {
  const src = await Deno.readTextFile(new URL("../../functions/revolut-webhook/index.ts", import.meta.url));
  const route = src.indexOf("if (isRevolutIncrementWebhookEvent(eventName))");
  const lifecycle = src.indexOf("// === Recovery-path detection ===");
  const signature = src.indexOf("invalid_signature");
  assert(route > 0 && lifecycle > 0 && signature > 0);
  assert(signature < route, "increment events must be signature-verified first");
  assert(route < lifecycle, "increment events must not reach the order lifecycle");
});

Deno.test("webhook AUTHORISED: evidence persisted, row metadata merged, no money mutation", async () => {
  const db = seed();
  const out = await deliver(db, "ORDER_INCREMENTAL_AUTHORISATION_AUTHORISED", orderWith({ state: "authorised" }, 800));
  assertEquals(out.httpStatus, 200);
  assertEquals(out.body.duplicate, false);
  assertEquals(out.body.increment_state, "authorised");
  assertEquals(out.body.reconciled_increment_row, true);
  const ev = db.rows("processed_revolut_events")[0];
  assertEquals(ev.event_type, "ORDER_INCREMENTAL_AUTHORISATION_AUTHORISED");
  assertEquals(ev.order_id, ORDER_ID);
  assertEquals(ev.trip_id, TRIP_ID);
  assertEquals(ev.applied_status, "evidence_only");
  const payload = ev.payload as Record<string, unknown>;
  assertEquals(payload.increment_state, "authorised");
  assertEquals(payload.increment_reason, null);
  assertEquals(payload.payment_session_id, SESSION_ID);
  const meta = db.rows("payment_session_authorisations")[0].metadata as Record<string, unknown>;
  assertEquals(meta.reason, "trip_modification", "existing metadata preserved");
  assertEquals((meta.provider_webhook_evidence as Record<string, unknown>).increment_state, "authorised");
  assertEquals(db.rows("admin_payment_audit").length, 1);
  // Evidence only: SSOT confirmation is not performed by the webhook.
  assertNoMoneyMutation(db);
  assertNoCardData(db);
});

Deno.test("webhook DECLINED: provider reason persisted verbatim, no money mutation", async () => {
  const db = seed();
  const out = await deliver(
    db,
    "ORDER_INCREMENTAL_AUTHORISATION_DECLINED",
    orderWith({ state: "declined", reason: "insufficient_funds" }),
  );
  assertEquals(out.httpStatus, 200);
  const payload = db.rows("processed_revolut_events")[0].payload as Record<string, unknown>;
  assertEquals(payload.increment_state, "declined");
  assertEquals(payload.increment_reason, "insufficient_funds");
  assertEquals(payload.increment_reason_field, "reason");
  assertEquals(payload.payment_authorised_amount_pence, 500);
  assertEquals(payload.increment_new_amount_pence, 800);
  assertEquals(payload.state_matches_event, true);
  assertNoMoneyMutation(db);
  assertNoCardData(db);
});

Deno.test("webhook FAILED: technical failure reason persisted as failed (not declined)", async () => {
  const db = seed();
  const out = await deliver(
    db,
    "ORDER_INCREMENTAL_AUTHORISATION_FAILED",
    orderWith({ state: "failed", reason: "technical_error" }),
  );
  assertEquals(out.httpStatus, 200);
  const payload = db.rows("processed_revolut_events")[0].payload as Record<string, unknown>;
  assertEquals(payload.increment_state, "failed");
  assertEquals(payload.increment_reason, "technical_error");
  const audit = db.rows("admin_payment_audit")[0].metadata as Record<string, unknown>;
  assertEquals(audit.state, "failed");
  assertEquals(audit.applied_status, "evidence_only");
  assertNoMoneyMutation(db);
});

Deno.test("webhook duplicate: second delivery is idempotent (200, no second row, no second audit)", async () => {
  const db = seed();
  const order = orderWith({ state: "declined", reason: "do_not_honour" });
  const first = await deliver(db, "ORDER_INCREMENTAL_AUTHORISATION_DECLINED", order);
  const second = await deliver(db, "ORDER_INCREMENTAL_AUTHORISATION_DECLINED", order);
  assertEquals(first.httpStatus, 200);
  assertEquals(second.httpStatus, 200);
  assertEquals(second.body.duplicate, true);
  assertEquals(db.rows("processed_revolut_events").length, 1);
  assertEquals(db.rows("admin_payment_audit").length, 1);
  assertNoMoneyMutation(db);
});

Deno.test("webhook retrieve failure: receipt recorded unresolved, 503 so Revolut redelivers", async () => {
  const db = seed();
  const out = await deliver(db, "ORDER_INCREMENTAL_AUTHORISATION_DECLINED", new Error("network down"));
  assertEquals(out.httpStatus, 503);
  const ev = db.rows("processed_revolut_events")[0];
  assertEquals(ev.applied_status, "evidence_unresolved");
  assertEquals(db.rows("admin_payment_audit").length, 0);
  assertNoMoneyMutation(db);
});

Deno.test("webhook lagging retrieve (still processing): 503, then settled redelivery captures reason", async () => {
  const db = seed();
  const lag = await deliver(db, "ORDER_INCREMENTAL_AUTHORISATION_DECLINED", orderWith({ state: "processing" }));
  assertEquals(lag.httpStatus, 503);
  const lagAgain = await deliver(db, "ORDER_INCREMENTAL_AUTHORISATION_DECLINED", orderWith({ state: "processing" }));
  assertEquals(lagAgain.httpStatus, 503, "duplicate while still lagging must keep asking for redelivery");
  const settled = await deliver(
    db,
    "ORDER_INCREMENTAL_AUTHORISATION_DECLINED",
    orderWith({ state: "declined", reason: "do_not_honour" }),
  );
  assertEquals(settled.httpStatus, 200);
  const rows = db.rows("processed_revolut_events");
  assertEquals(rows.length, 2);
  assertEquals((rows[1].payload as Record<string, unknown>).increment_reason, "do_not_honour");
  assertNoMoneyMutation(db);
});

Deno.test("webhook without order_id: acknowledged, nothing persisted", async () => {
  const db = seed();
  const out = await handleRevolutIncrementWebhookEvidence({
    supabase: asSupabase(db),
    eventName: "ORDER_INCREMENTAL_AUTHORISATION_FAILED",
    orderId: null,
    merchantOrderExtRef: null,
    requestTimestamp: null,
    retrieveOrder: () => Promise.reject(new Error("must not be called")),
  });
  assertEquals(out.httpStatus, 200);
  assertEquals(db.writes.length, 0);
});
