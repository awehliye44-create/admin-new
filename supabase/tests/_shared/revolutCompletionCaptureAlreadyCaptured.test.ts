/**
 * Behavioural: provider order already COMPLETED → completion reconciliation.
 * Regression for `capturedAmountPence` ReferenceError in the already_captured
 * branch (residual-release + provider-fee evidence was silently skipped).
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { executeRevolutTripCompletionCapture } from "../../functions/_shared/revolutCompletionCapture.ts";
import { asSupabase, InMemorySupabase, stubFetch } from "./support/inMemorySupabase.ts";

const TRIP_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const ORDER_ID = "ord_already_captured";
const CLIENT_ACTION_ID = "66666666-6666-4666-8666-666666666666";
const AUTHORISED = 2000;
const PROVIDER_CAPTURED = 1500;

const PROVIDER_FEE = 23;

function completedOrder(fees?: unknown[]) {
  return {
    id: ORDER_ID,
    state: "COMPLETED",
    amount: AUTHORISED,
    outstanding_amount: 0,
    currency: "GBP",
    payments: [{
      id: "pay_1",
      state: "CAPTURED",
      amount: PROVIDER_CAPTURED,
      authorised_amount: AUTHORISED,
      payment_method: { type: "card", card_last_four: "4242" },
      ...(fees ? { fees } : {}),
    }],
  };
}

function seedDb() {
  return new InMemorySupabase({
    tables: {
      trips: [{
        id: TRIP_ID,
        trip_code: "MK-TEST-001",
        status: "completed",
        provider_order_id: ORDER_ID,
        client_action_id: CLIENT_ACTION_ID,
        financial_model: "PLATFORM_COLLECTED",
        final_fare_pence: PROVIDER_CAPTURED,
        authorised_amount_pence: AUTHORISED,
        capture_amount_pence: null,
        payment_status: "authorised",
      }],
      payment_sessions: [{
        id: SESSION_ID,
        client_action_id: CLIENT_ACTION_ID,
        provider_order_id: ORDER_ID,
        trip_id: TRIP_ID,
        purpose: "TRIP_PAYMENT",
        status: "authorised_hold",
        authorised_amount_pence: AUTHORISED,
        total_authorised_amount_pence: AUTHORISED,
        metadata: {},
        created_at: "2026-10-02T10:00:00.000Z",
      }],
      payments: [{
        id: "p1",
        trip_id: TRIP_ID,
        provider_order_id: ORDER_ID,
        status: "authorised",
        captured_amount_pence: null,
      }],
      payment_provider_vault: [],
    },
    rpc: {
      assert_trip_completion_customer_payment_gate: () => ({ data: { ok: true }, error: null }),
    },
  });
}

async function runAlreadyCaptured(order: Record<string, unknown>) {
  Deno.env.set("REVOLUT_MERCHANT_SECRET_KEY", "sk_fixture_unit_test_only_0000000000");
  const db = seedDb();
  const fetchStub = stubFetch((call) => {
    if (call.method === "GET" && call.url.endsWith(`/orders/${ORDER_ID}`)) {
      return { status: 200, body: order };
    }
    return { status: 500, body: { message: `unexpected ${call.method} ${call.url}` } };
  });
  try {
    const result = await executeRevolutTripCompletionCapture({
      supabase: asSupabase(db),
      trip: { ...db.rows("trips")[0] },
      tipPence: 0,
    });
    return { db, result, calls: fetchStub.calls };
  } finally {
    fetchStub.restore();
    Deno.env.delete("REVOLUT_MERCHANT_SECRET_KEY");
  }
}

Deno.test("already_captured: provider-confirmed ACQUIRING fee persisted as ACTUAL, still no second capture", async () => {
  const { db, result, calls } = await runAlreadyCaptured(
    completedOrder([{ type: "ACQUIRING", amount: PROVIDER_FEE }]),
  );
  assertEquals(result.status, "already_captured");
  assertEquals(result.capture_amount_pence, PROVIDER_CAPTURED);
  assertEquals(calls.filter((c) => c.method !== "GET").length, 0);
  const session = db.rows("payment_sessions")[0];
  assertEquals(session.provider_processing_fee_pence, PROVIDER_FEE);
  assertEquals(String(session.fee_status).toUpperCase(), "ACTUAL");
});

Deno.test("already_captured: fee absent from provider payload is PENDING, never an invented 0", async () => {
  const { db, result } = await runAlreadyCaptured(completedOrder());
  assertEquals(result.status, "already_captured");
  const session = db.rows("payment_sessions")[0];
  assertEquals(session.provider_processing_fee_pence ?? null, null);
  assertEquals(String(session.fee_status).toUpperCase(), "PENDING");
});

Deno.test("already_captured: no ReferenceError, no second capture, provider captured amount persisted", async () => {
  Deno.env.set("REVOLUT_MERCHANT_SECRET_KEY", "sk_fixture_unit_test_only_0000000000");
  const db = new InMemorySupabase({
    tables: {
      trips: [{
        id: TRIP_ID,
        trip_code: "MK-TEST-001",
        status: "completed",
        provider_order_id: ORDER_ID,
        client_action_id: CLIENT_ACTION_ID,
        financial_model: "PLATFORM_COLLECTED",
        final_fare_pence: PROVIDER_CAPTURED,
        authorised_amount_pence: AUTHORISED,
        capture_amount_pence: null,
        payment_status: "authorised",
      }],
      payment_sessions: [{
        id: SESSION_ID,
        client_action_id: CLIENT_ACTION_ID,
        provider_order_id: ORDER_ID,
        trip_id: TRIP_ID,
        purpose: "TRIP_PAYMENT",
        status: "authorised_hold",
        authorised_amount_pence: AUTHORISED,
        total_authorised_amount_pence: AUTHORISED,
        metadata: {},
        created_at: "2026-10-02T10:00:00.000Z",
      }],
      payments: [{
        id: "p1",
        trip_id: TRIP_ID,
        provider_order_id: ORDER_ID,
        status: "authorised",
        captured_amount_pence: null,
      }],
      payment_provider_vault: [],
    },
    rpc: {
      assert_trip_completion_customer_payment_gate: () => ({ data: { ok: true }, error: null }),
    },
  });

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
  };
  const fetchStub = stubFetch((call) => {
    if (call.method === "GET" && call.url.endsWith(`/orders/${ORDER_ID}`)) {
      return { status: 200, body: completedOrder() };
    }
    return { status: 500, body: { message: `unexpected ${call.method} ${call.url}` } };
  });

  let result;
  try {
    result = await executeRevolutTripCompletionCapture({
      supabase: asSupabase(db),
      trip: { ...db.rows("trips")[0] },
      tipPence: 0,
    });
  } finally {
    fetchStub.restore();
    console.error = originalError;
    Deno.env.delete("REVOLUT_MERCHANT_SECRET_KEY");
  }

  assert(
    !errors.some((e) => /ReferenceError|capturedAmountPence is not defined/.test(e)),
    `ReferenceError logged: ${errors.join(" | ")}`,
  );
  assert(!errors.some((e) => e.includes("already_captured persist failed")), errors.join(" | "));

  assertEquals(result.status, "already_captured");
  assertEquals(result.success, true);
  assertEquals(result.capture_amount_pence, PROVIDER_CAPTURED);

  // No second capture: only provider GETs, never POST /capture.
  assertEquals(fetchStub.calls.filter((c) => c.method !== "GET").length, 0);
  assert(!fetchStub.calls.some((c) => c.url.includes("/capture")));

  const trip = db.rows("trips")[0];
  assertEquals(trip.capture_amount_pence, PROVIDER_CAPTURED);
  assertEquals(trip.payment_status, "captured");
  const session = db.rows("payment_sessions")[0];
  assertEquals(session.captured_amount_pence, PROVIDER_CAPTURED);
  assertEquals(db.rows("payments")[0].captured_amount_pence, PROVIDER_CAPTURED);

  // Residual-release evidence now runs with the canonical captured amount.
  const meta = session.metadata as Record<string, unknown>;
  assertEquals(meta.expected_release_pence, AUTHORISED - PROVIDER_CAPTURED);
  const keys = meta.residual_release_idempotency_keys as string[];
  assert(Array.isArray(keys) && keys.some((k) => k.includes(String(PROVIDER_CAPTURED))), JSON.stringify(keys));
  assert(session.release_evidence_status != null, "release evidence status persisted");
});
