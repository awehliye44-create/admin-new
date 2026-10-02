/**
 * LOCK — concurrent terminal disposition is deterministic and single-shot.
 *
 * cancel-trip and release-terminal-trip-hold (trips trigger) dispose the same
 * cancellation concurrently. Same decision → same idempotency key → exactly one
 * provider mutation (capture 450 once; remainder 300 released by that capture;
 * never a full release) and exactly one TRIP_EARNING_NET.
 *
 * The financial lock claim is a compare-and-set on the observed
 * financial_operation_started_at, and every invocation claims with its own
 * owner. Before: the claim filtered on the session id only and the owner was
 * `terminal_disposition:${key}` for both callers, so both could claim.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { disposeTerminalTripPayment } from "../../functions/_shared/terminalTripPaymentDisposition.ts";
import { postTerminalEntitlementFromSettlement } from "../../functions/_shared/terminalOutcomeEntitlementSSOT.ts";
import { createFakeDb, INCIDENT_CANCELLED_AT, INCIDENT_SEGMENTS } from "./waitingSsotFakeDb.ts";

const TRIP = "race-trip-0001";
const SESSION = "race-ps-0001";
const ORDER = "race-order-0001";
const DRIVER = "race-driver-0001";
const AREA = "cb58f1bd-8b6f-45b9-ad31-b3140309892c";
const VEHICLE = "a5c59e9b-ed66-4dd1-8043-1f4730691c12";

const GO_POLICY = {
  cancellation_fee_pence: 0,
  cancellation_grace_period_minutes: 3,
  cancellation_apply_after_arrival_only: true,
  no_show_fee_pence: 450,
  no_show_wait_time_minutes: 5,
  no_show_apply_after_arrival_only: true,
  late_cancel_enabled: true,
  late_cancel_threshold_minutes: 30,
  late_cancel_fee_pence: 450,
  arrival_cancellation_enabled: true,
  arrival_cancellation_fee_pence: 450,
  arrival_cancellation_apply_after_free_waiting_expired: true,
  arrival_cancellation_after_arrival_only: true,
  free_waiting_minutes: 3,
};

function seed() {
  return {
    trips: [{
      id: TRIP,
      status: "cancelled",
      started_at: null,
      arrived_at: "2026-10-02T10:07:36.310Z",
      free_wait_expires_at: "2026-10-02T10:10:36.310Z",
      cancelled_at: INCIDENT_CANCELLED_AT,
      cancelled_by: "rider",
      cancellation_reason: "customer_cancel",
      driver_id: null,
      confirmed_driver_id: null,
      previous_driver_id: DRIVER,
      service_area_id: AREA,
      vehicle_type_id: VEHICLE,
      payment_provider: "revolut",
      provider_order_id: ORDER,
      payment_session_id: SESSION,
      authorised_amount_pence: 750,
      payment_status: "authorised",
      arrival_cancellation_applied: false,
      pickup_waiting_counted_seconds: 0,
    }],
    payment_sessions: [{
      id: SESSION,
      trip_id: TRIP,
      purpose: "RIDE_BOOKING",
      provider_order_id: ORDER,
      authorised_amount_pence: 750,
      captured_amount_pence: 0,
      released_amount_pence: 0,
      provider_state: "AUTHORISED",
      status: "authorised_hold",
      metadata: {},
      financial_operation_state: null,
      financial_operation_owner: null,
      financial_operation_started_at: null,
      created_at: "2026-10-02T10:00:00.000Z",
    }],
    fare_pricing_settings: [{ id: "9ab39ea8-536c-4e4a-864e-218db52b7263", service_area_id: AREA, vehicle_type_id: VEHICLE, ...GO_POLICY }],
    trip_waiting_segments: INCIDENT_SEGMENTS.map((s, i) => ({
      id: `seg-${i + 1}`,
      trip_id: TRIP,
      location_type: "pickup",
      stop_id: null,
      ...s,
    })),
    driver_wallet_ledger: [] as Record<string, unknown>[],
  };
}

/** Holds every lock reader until `parties` have read — both observe IDLE. */
function withLockReadBarrier(db: ReturnType<typeof createFakeDb>, parties: number) {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  return {
    from(table: string) {
      const b = db.client.from(table);
      if (table !== "payment_sessions") return b;
      const origSelect = b.select;
      b.select = (cols = "*") => {
        const r = origSelect.call(b, cols);
        if (!String(cols).includes("financial_operation_started_at")) return r;
        const origMaybe = r.maybeSingle;
        r.maybeSingle = async () => {
          const res = await origMaybe.call(r);
          arrived += 1;
          if (arrived >= parties) open();
          await gate;
          return res;
        };
        return r;
      };
      return b;
    },
  };
}

function revolutStub() {
  const order = { state: "AUTHORISED", amount: 750, completed_amount: 0 };
  const calls = { capture: [] as number[], cancel: 0, get: 0 };
  const fake = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    await new Promise((r) => setTimeout(r, 2));
    if (method === "POST" && url.endsWith(`/orders/${ORDER}/capture`)) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.capture.push(Number(body.amount));
      order.state = "COMPLETED";
      order.completed_amount = Number(body.amount);
      return new Response(JSON.stringify({ id: ORDER, ...order }), { status: 200 });
    }
    if (method === "POST" && url.endsWith(`/orders/${ORDER}/cancel`)) {
      calls.cancel += 1;
      order.state = "CANCELLED";
      return new Response(JSON.stringify({ id: ORDER, ...order }), { status: 200 });
    }
    if (method === "GET" && url.includes(`/orders/${ORDER}`)) {
      calls.get += 1;
      return new Response(JSON.stringify({ id: ORDER, ...order }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fake, calls, order };
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const l = console.log;
  const w = console.warn;
  const e = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = l;
    console.warn = w;
    console.error = e;
  }
}

Deno.test("race: concurrent disposals (segments ≥ 180 s, cache 0) → capture 450 once, release 300, never a full release", async () => {
  const db = createFakeDb(seed());
  const client = withLockReadBarrier(db, 2);
  const stub = revolutStub();
  const realFetch = globalThis.fetch;
  const prevKey = Deno.env.get("REVOLUT_MERCHANT_SECRET_KEY");
  Deno.env.set("REVOLUT_MERCHANT_SECRET_KEY", "sk_sandbox_race_lock_test");
  globalThis.fetch = stub.fake;
  try {
    const [a, b] = await quietly(() =>
      Promise.all([
        disposeTerminalTripPayment(client as never, { tripId: TRIP, reason: "customer_cancel" }),
        disposeTerminalTripPayment(client as never, { tripId: TRIP, reason: "customer_cancel" }),
      ])
    );

    // Same decision, same key.
    assertEquals(a.disposition_key, b.disposition_key);
    assertEquals(a.decision?.disposition_reason, "ARRIVAL_CANCELLATION_FEE");
    assertEquals(b.decision?.disposition_reason, "ARRIVAL_CANCELLATION_FEE");
    assertEquals(a.decision?.decision_evidence.pickup_waiting_counted_seconds, 244);

    // Exactly one provider mutation.
    assertEquals(stub.calls.capture, [450]);
    assertEquals(stub.calls.cancel, 0);
    const outcomes = [a.outcome, b.outcome].sort();
    assertEquals(outcomes, ["FEE_CAPTURED_AND_REMAINDER_RELEASED", "PROVIDER_PENDING_RECONCILIATION"]);
    const winner = a.outcome === "FEE_CAPTURED_AND_REMAINDER_RELEASED" ? a : b;
    assertEquals(winner.captured_fee_pence, 450);
    assertEquals(winner.released_pence, 300);

    // A later replay is idempotent: still one capture, no cancel.
    const replay = await quietly(() =>
      disposeTerminalTripPayment(db.client as never, { tripId: TRIP, reason: "customer_cancel" })
    );
    assertEquals(replay.disposition_key, a.disposition_key);
    assert(
      ["FEE_CAPTURED_AND_REMAINDER_RELEASED", "ALREADY_RELEASED_RECONCILED"].includes(replay.outcome),
      replay.outcome,
    );
    assertEquals(stub.calls.capture, [450]);
    assertEquals(stub.calls.cancel, 0);

    // Arrival legacy metadata: integer pence, decided at cancelled_at.
    const trip = db.tables.trips[0]!;
    assertEquals(trip.arrival_cancellation_applied, true);
    assertEquals(trip.arrival_cancellation_fee, 450);
    assertEquals(trip.arrival_cancellation_applied_at, INCIDENT_CANCELLED_AT);
    assertEquals(trip.cancellation_fee_pence, 450);
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey == null) Deno.env.delete("REVOLUT_MERCHANT_SECRET_KEY");
    else Deno.env.set("REVOLUT_MERCHANT_SECRET_KEY", prevKey);
  }
});

Deno.test("race: concurrent terminal postings → exactly one TRIP_EARNING_NET (unique index)", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const supabase = {
    from(_t: string) {
      const filters: Record<string, unknown> = {};
      const api = {
        select() {
          return api;
        },
        eq(k: string, v: unknown) {
          filters[k] = v;
          return api;
        },
        async in() {
          await Promise.resolve();
          return { data: rows.filter((r) => r.related_trip_id === filters.related_trip_id).map((r) => ({ type: r.type })) };
        },
        async maybeSingle() {
          await Promise.resolve();
          const m = rows.find((r) => r.related_trip_id === filters.related_trip_id && r.type === filters.type);
          return { data: m ? { id: m.id } : null };
        },
        async insert(row: Record<string, unknown>) {
          await Promise.resolve();
          if (rows.some((r) => r.related_trip_id === row.related_trip_id && r.type === row.type)) {
            return { error: { code: "23505", message: "driver_wallet_ledger_trip_earning_net_unique" } };
          }
          rows.push({ id: `l-${rows.length + 1}`, ...row });
          return { error: null };
        },
      };
      return api;
    },
  };
  const ev = { payment_session_id: SESSION, captured_pence: 450, provider_fee_pence: 24, provider_fee_confirmed: true };
  const run = () =>
    postTerminalEntitlementFromSettlement({
      supabase: supabase as never,
      tripId: TRIP,
      driverId: DRIVER,
      outcome: "ARRIVAL_CANCELLATION",
      currency: "GBP",
      evidence: ev,
    });
  const results = await Promise.all([run(), run(), run()]);
  for (const r of results) {
    assertEquals(r.credited, true);
    assertEquals(r.entitlement_pence, 426);
  }
  assertEquals(rows.length, 1);
  assertEquals(rows[0]!.amount_pence, 426);
  assertEquals(rows[0]!.driver_id, DRIVER);
});
