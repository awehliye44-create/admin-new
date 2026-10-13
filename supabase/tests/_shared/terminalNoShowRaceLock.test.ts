/**
 * LOCK — concurrent No-Show disposition is single-shot (MK-261002-015 shape).
 *
 * cancel-trip (driver No-Show → driver_cancel_terminal, waiting resolved from
 * segments, fee override 450) and release-terminal-trip-hold (trigger default
 * sweep_fallback, reads segments itself) dispose
 * the same No-Show concurrently with the cached counter at 0. Same decision →
 * same idempotency key → capture 450 once, remainder 300 released by that
 * capture, never a full release, never Arrival Cancellation metadata, and
 * exactly one TRIP_EARNING_NET of 426 for the previous driver.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { disposeTerminalTripPayment } from "../../functions/_shared/terminalTripPaymentDisposition.ts";
import { postTerminalEntitlementFromSettlement } from "../../functions/_shared/terminalOutcomeEntitlementSSOT.ts";
import { createFakeDb } from "./waitingSsotFakeDb.ts";

const TRIP = "98cab445-aa22-401a-8aac-e53210990273";
const SESSION = "f96d1b91-6a83-4f2f-9611-0a9b29a6cc48";
const ORDER = "race-order-015";
const DRIVER = "56136f5f-1a3a-4a14-bb23-439b3951415a";
const AREA = "cb58f1bd-8b6f-45b9-ad31-b3140309892c";
const VEHICLE = "a5c59e9b-ed66-4dd1-8043-1f4730691c12";
const ARRIVED_AT = "2026-10-02T12:37:42.107Z";
const CANCELLED_AT = "2026-10-02T12:43:36.989Z";

/** MK-261002-015 pickup segments: 136 + 45 + 143 = 324 s. */
const SEGMENTS_015 = [
  { started_at: "2026-10-02T12:37:42.107Z", ended_at: "2026-10-02T12:39:58.598Z" },
  { started_at: "2026-10-02T12:40:13.845Z", ended_at: "2026-10-02T12:40:58.628Z" },
  { started_at: "2026-10-02T12:41:13.709Z", ended_at: CANCELLED_AT },
];

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
      status: "no_show",
      started_at: null,
      arrived_at: ARRIVED_AT,
      free_wait_expires_at: "2026-10-02T12:40:42.107Z",
      cancelled_at: CANCELLED_AT,
      cancelled_by: "driver",
      cancellation_reason: "no_show",
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
      created_at: "2026-10-02T12:37:23.279Z",
    }],
    fare_pricing_settings: [{ id: "9ab39ea8-536c-4e4a-864e-218db52b7263", service_area_id: AREA, vehicle_type_id: VEHICLE, ...GO_POLICY }],
    trip_waiting_segments: SEGMENTS_015.map((s, i) => ({
      id: `seg-015-${i + 1}`,
      trip_id: TRIP,
      location_type: "pickup",
      stop_id: null,
      ...s,
    })),
    driver_wallet_ledger: [] as Record<string, unknown>[],
  };
}

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

Deno.test("No-Show race: cancel-trip vs release-terminal-trip-hold (segments 324 s, cache 0) → capture 450 once, release 300", async () => {
  const db = createFakeDb(seed());
  const client = withLockReadBarrier(db, 2);
  const stub = revolutStub();
  const realFetch = globalThis.fetch;
  const prevKey = Deno.env.get("REVOLUT_MERCHANT_SECRET_KEY");
  Deno.env.set("REVOLUT_MERCHANT_SECRET_KEY", "sk_sandbox_no_show_race_lock_test");
  globalThis.fetch = stub.fake;
  try {
    const [cancelTrip, releaseHold] = await quietly(() =>
      Promise.all([
        disposeTerminalTripPayment(client as never, {
          tripId: TRIP,
          reason: "driver_cancel_terminal",
          feePence: 450,
          forceFeePenceOverride: true,
          canonicalPickupWaitingSeconds: 324,
        }),
        disposeTerminalTripPayment(client as never, { tripId: TRIP, reason: "sweep_fallback" }),
      ])
    );

    assertEquals(cancelTrip.disposition_key, releaseHold.disposition_key);
    assertEquals(cancelTrip.decision?.disposition_reason, "CUSTOMER_NO_SHOW");
    assertEquals(releaseHold.decision?.disposition_reason, "CUSTOMER_NO_SHOW");
    // cancel-trip enforced the 300 s threshold from segments; the trigger path decides
    // from the recorded no_show and never reads the cache.
    assertEquals(cancelTrip.decision?.decision_evidence.pickup_waiting_counted_seconds, 324);
    assertEquals(cancelTrip.decision?.decision_evidence.waiting_evidence_source, "trip_waiting_segments:caller");
    assertEquals(releaseHold.decision?.decision_evidence.pickup_waiting_counted_seconds, null);

    assertEquals(stub.calls.capture, [450]);
    assertEquals(stub.calls.cancel, 0);
    const outcomes = [cancelTrip.outcome, releaseHold.outcome].sort();
    assertEquals(outcomes, ["FEE_CAPTURED_AND_REMAINDER_RELEASED", "PROVIDER_PENDING_RECONCILIATION"]);
    const winner = cancelTrip.outcome === "FEE_CAPTURED_AND_REMAINDER_RELEASED" ? cancelTrip : releaseHold;
    assertEquals(winner.captured_fee_pence, 450);
    assertEquals(winner.released_pence, 300);

    const replay = await quietly(() =>
      disposeTerminalTripPayment(db.client as never, { tripId: TRIP, reason: "sweep_fallback" })
    );
    assertEquals(replay.disposition_key, cancelTrip.disposition_key);
    assert(
      ["FEE_CAPTURED_AND_REMAINDER_RELEASED", "ALREADY_RELEASED_RECONCILED"].includes(replay.outcome),
      replay.outcome,
    );
    assertEquals(stub.calls.capture, [450]);
    assertEquals(stub.calls.cancel, 0);

    const trip = db.tables.trips[0]!;
    assertEquals(trip.no_show_charge_pence, 450);
    assertEquals(trip.arrival_cancellation_applied, false);
    assertEquals(trip.completed_at ?? null, null);
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey == null) Deno.env.delete("REVOLUT_MERCHANT_SECRET_KEY");
    else Deno.env.set("REVOLUT_MERCHANT_SECRET_KEY", prevKey);
  }
});

Deno.test("No-Show race: a stale cache never turns an unrecorded driver cancellation into a No-Show charge", async () => {
  const base = seed();
  Object.assign(base.trips[0]!, {
    status: "cancelled",
    cancellation_reason: "driver_cancel",
    pickup_waiting_counted_seconds: 324,
  });
  const db = createFakeDb(base);
  const stub = revolutStub();
  const realFetch = globalThis.fetch;
  const prevKey = Deno.env.get("REVOLUT_MERCHANT_SECRET_KEY");
  Deno.env.set("REVOLUT_MERCHANT_SECRET_KEY", "sk_sandbox_no_show_race_lock_test");
  globalThis.fetch = stub.fake;
  try {
    const r = await quietly(() => disposeTerminalTripPayment(db.client as never, { tripId: TRIP, reason: "sweep_fallback" }));
    const reason: string | undefined = r.decision?.disposition_reason;
    assert(reason !== "CUSTOMER_NO_SHOW", String(reason));
    assertEquals(stub.calls.capture, []);
    assertEquals(db.tables.trips[0]!.no_show_charge_pence ?? null, null);
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey == null) Deno.env.delete("REVOLUT_MERCHANT_SECRET_KEY");
    else Deno.env.set("REVOLUT_MERCHANT_SECRET_KEY", prevKey);
  }
});

Deno.test("No-Show race: concurrent NO_SHOW postings → exactly one TRIP_EARNING_NET 426 for the previous driver", async () => {
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
      outcome: "NO_SHOW",
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
