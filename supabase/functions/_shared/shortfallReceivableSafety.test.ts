/**
 * Lock: partial-capture shortfall is always durable.
 * receivable → finance exception → ops alert escalation; idempotent on retry.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  buildShortfallEscalationFingerprint,
  buildShortfallExceptionIdempotencyKey,
  ensureShortfallReceivableOrException,
  isWithinReceivablesLedger,
  SHORTFALL_ESCALATION_LOG_TAG,
  SHORTFALL_SAFETY_STATE,
  shortfallPenceFromSessionMarker,
  type ShortfallSafetyInput,
} from "./shortfallReceivableSafety.ts";
import { buildDeclinedWaitingReceivableIdempotencyKey } from "./customerReceivableSSOT.ts";

type Fail = { receivable?: number | "always"; exception?: boolean; opsAlert?: boolean; resolve?: boolean };

function fakeDb(fail: Fail = {}) {
  const receivables = new Map<string, { id: string; trip: string }>();
  const exceptions = new Map<string, { id: string; trip: string; status: string; occurrence_count: number; shortfall: number; receivable_id: string | null }>();
  const opsAlerts = new Map<string, Record<string, unknown>>();
  const auditLogs: Record<string, unknown>[] = [];
  const calls: string[] = [];
  let receivableFailures = 0;

  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push(name);
      if (name === "customer_receivable_record_declined_increment") {
        const shouldFail = fail.receivable === "always"
          || (typeof fail.receivable === "number" && receivableFailures < fail.receivable);
        if (shouldFail) {
          receivableFailures += 1;
          return Promise.resolve({ data: null, error: { message: "could not serialize access" } });
        }
        const key = String(args.p_idempotency_key);
        const existing = receivables.get(key);
        if (existing) {
          return Promise.resolve({ data: { ok: true, receivable_id: existing.id, created: false }, error: null });
        }
        const row = { id: `recv-${receivables.size + 1}`, trip: String(args.p_source_trip_id) };
        receivables.set(key, row);
        return Promise.resolve({ data: { ok: true, receivable_id: row.id, created: true }, error: null });
      }
      if (name === "finance_record_shortfall_exception") {
        if (fail.exception) {
          return Promise.resolve({ data: null, error: { message: "connection reset" } });
        }
        const key = String(args.p_idempotency_key);
        const existing = exceptions.get(key);
        if (existing) {
          existing.occurrence_count += 1;
          return Promise.resolve({
            data: { ok: true, created: false, exception_id: existing.id, status: existing.status },
            error: null,
          });
        }
        const row = {
          id: `fse-${exceptions.size + 1}`,
          trip: String(args.p_trip_id),
          status: "OPEN",
          occurrence_count: 1,
          shortfall: Number(args.p_shortfall_pence),
          receivable_id: null,
        };
        exceptions.set(key, row);
        return Promise.resolve({ data: { ok: true, created: true, exception_id: row.id, status: "OPEN" }, error: null });
      }
      if (name === "finance_resolve_shortfall_exception_receivable") {
        if (fail.resolve) return Promise.resolve({ data: null, error: { message: "timeout" } });
        for (const ex of exceptions.values()) {
          if (ex.trip === String(args.p_trip_id) && ex.status === "OPEN") {
            ex.status = "RESOLVED_RECEIVABLE_RECORDED";
            ex.receivable_id = String(args.p_receivable_id);
          }
        }
        return Promise.resolve({ data: { ok: true }, error: null });
      }
      throw new Error(`unexpected rpc ${name}`);
    },
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          calls.push(`insert:${table}`);
          if (table === "audit_logs") {
            auditLogs.push(row);
            return Promise.resolve({ error: null });
          }
          if (table === "ops_alerts") {
            if (fail.opsAlert) return Promise.resolve({ error: { code: "08006", message: "down" } });
            const fp = String(row.fingerprint);
            if (opsAlerts.has(fp)) return Promise.resolve({ error: { code: "23505", message: "duplicate" } });
            opsAlerts.set(fp, row);
            return Promise.resolve({ error: null });
          }
          throw new Error(`unexpected insert ${table}`);
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, receivables, exceptions, opsAlerts, auditLogs, calls };
}

const TRIP = "11111111-1111-1111-1111-111111111111";

function input(patch: Partial<ShortfallSafetyInput> = {}): ShortfallSafetyInput {
  return {
    trip_id: TRIP,
    trip_code: "MK-261014-001",
    payment_session_id: "ps-1",
    provider_order_id: "order-1",
    customer_id: "cust-1",
    expected_fare_pence: 1240,
    captured_pence: 1200,
    shortfall_pence: 40,
    currency: "GBP",
    pickup_waiting_charge_pence: 40,
    provider_state: "COMPLETED",
    source: "partial_capture",
    ...patch,
  };
}

const silent = () => {};

Deno.test("partial capture: receivable recorded once, no exception, no alert", async () => {
  const db = fakeDb();
  const out = await ensureShortfallReceivableOrException(db.client, input(), { log: silent });
  assertEquals(out.state, SHORTFALL_SAFETY_STATE.RECEIVABLE_RECORDED);
  assertEquals(out.manual_review, false);
  assertEquals(out.shortfall_pence, 40);
  assertEquals(out.receivable_created, true);
  assertEquals(db.receivables.size, 1);
  assert(db.receivables.has(buildDeclinedWaitingReceivableIdempotencyKey(TRIP)));
  assertEquals(db.exceptions.size, 0);
  assertEquals(db.opsAlerts.size, 0);
});

Deno.test("transient receivable failure: retried once, receivable recorded", async () => {
  const db = fakeDb({ receivable: 1 });
  const out = await ensureShortfallReceivableOrException(db.client, input(), { log: silent });
  assertEquals(out.state, SHORTFALL_SAFETY_STATE.RECEIVABLE_RECORDED);
  assertEquals(out.receivable_attempts, 2);
  assertEquals(db.exceptions.size, 0);
});

Deno.test("receivable write failure: durable exception with trip, session, fare, captured, shortfall", async () => {
  const db = fakeDb({ receivable: "always" });
  const logs: string[] = [];
  const out = await ensureShortfallReceivableOrException(db.client, input(), {
    log: (tag) => logs.push(tag),
  });
  assertEquals(out.state, SHORTFALL_SAFETY_STATE.EXCEPTION_RECORDED);
  assertEquals(out.manual_review, true);
  assertEquals(out.receivable_attempts, 2);
  assertEquals(db.receivables.size, 0);
  const ex = db.exceptions.get(buildShortfallExceptionIdempotencyKey(TRIP));
  assert(ex);
  assertEquals(ex.shortfall, 40);
  assertEquals(ex.status, "OPEN");
  const alert = db.opsAlerts.get(buildShortfallEscalationFingerprint(TRIP));
  assertEquals(alert?.severity, "warning");
  assertEquals((alert?.metadata as Record<string, unknown>).expected_fare_pence, 1240);
  assertEquals((alert?.metadata as Record<string, unknown>).captured_pence, 1200);
  assertEquals((alert?.metadata as Record<string, unknown>).payment_session_id, "ps-1");
  assert(!logs.includes(SHORTFALL_ESCALATION_LOG_TAG));
});

Deno.test("exception persisted through its own RPC after the receivable RPC failed", async () => {
  const db = fakeDb({ receivable: "always" });
  await ensureShortfallReceivableOrException(db.client, input(), { log: silent });
  const recvIdx = db.calls.lastIndexOf("customer_receivable_record_declined_increment");
  const exIdx = db.calls.indexOf("finance_record_shortfall_exception");
  assert(exIdx > recvIdx, "exception write is a separate call after receivable failure");
});

Deno.test("receivable and exception both fail: critical ops alert + structured escalation log", async () => {
  const db = fakeDb({ receivable: "always", exception: true });
  const logs: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  const out = await ensureShortfallReceivableOrException(db.client, input(), {
    log: (tag, payload) => logs.push({ tag, payload }),
  });
  assertEquals(out.state, SHORTFALL_SAFETY_STATE.ESCALATED_UNRECORDED);
  assertEquals(out.manual_review, true);
  assertEquals(out.escalated, true);
  assertEquals(db.opsAlerts.get(buildShortfallEscalationFingerprint(TRIP))?.severity, "critical");
  const esc = logs.find((l) => l.tag === SHORTFALL_ESCALATION_LOG_TAG);
  assert(esc);
  assertEquals(esc.payload.shortfall_pence, 40);
  assertEquals(esc.payload.payment_session_id, "ps-1");
});

Deno.test("every durable write fails: still returns (never throws) and logs escalation", async () => {
  const db = fakeDb({ receivable: "always", exception: true, opsAlert: true });
  const logs: string[] = [];
  const out = await ensureShortfallReceivableOrException(db.client, input(), { log: (t) => logs.push(t) });
  assertEquals(out.state, SHORTFALL_SAFETY_STATE.ESCALATED_UNRECORDED);
  assertEquals(out.escalated, false);
  assert(logs.includes(SHORTFALL_ESCALATION_LOG_TAG));
});

Deno.test("recordReceivable throwing is treated as a failed attempt, not a crash", async () => {
  const db = fakeDb();
  const out = await ensureShortfallReceivableOrException(db.client, input(), {
    log: silent,
    recordReceivable: () => Promise.reject(new Error("fetch failed")),
  });
  assertEquals(out.state, SHORTFALL_SAFETY_STATE.EXCEPTION_RECORDED);
  assertEquals(out.receivable_attempts, 2);
});

Deno.test("duplicate callbacks converge: one receivable, created only once", async () => {
  const db = fakeDb();
  const [a, b] = await Promise.all([
    ensureShortfallReceivableOrException(db.client, input(), { log: silent }),
    ensureShortfallReceivableOrException(db.client, input({ source: "already_captured_retry" }), { log: silent }),
  ]);
  assertEquals(db.receivables.size, 1);
  assertEquals(a.receivable_id, b.receivable_id);
  assertEquals([a.receivable_created, b.receivable_created].filter(Boolean).length, 1);
});

Deno.test("retries while DB is down: one exception (occurrence counted), one open alert", async () => {
  const db = fakeDb({ receivable: "always" });
  for (let i = 0; i < 3; i += 1) {
    const out = await ensureShortfallReceivableOrException(db.client, input(), { log: silent });
    assertEquals(out.state, SHORTFALL_SAFETY_STATE.EXCEPTION_RECORDED);
    assertEquals(out.exception_created, i === 0);
    assertEquals(out.escalated, true);
  }
  assertEquals(db.exceptions.size, 1);
  assertEquals(db.exceptions.get(buildShortfallExceptionIdempotencyKey(TRIP))?.occurrence_count, 3);
  assertEquals(db.opsAlerts.size, 1);
});

Deno.test("later successful retry records the receivable and resolves the open exception", async () => {
  const db = fakeDb({ receivable: 2 });
  const first = await ensureShortfallReceivableOrException(db.client, input(), { log: silent });
  assertEquals(first.state, SHORTFALL_SAFETY_STATE.EXCEPTION_RECORDED);
  const retry = await ensureShortfallReceivableOrException(db.client, input({ source: "already_captured_retry" }), {
    log: silent,
  });
  assertEquals(retry.state, SHORTFALL_SAFETY_STATE.RECEIVABLE_RECORDED);
  const ex = db.exceptions.get(buildShortfallExceptionIdempotencyKey(TRIP));
  assertEquals(ex?.status, "RESOLVED_RECEIVABLE_RECORDED");
  assertEquals(ex?.receivable_id, retry.receivable_id);
  assertEquals(db.receivables.size, 1);
});

Deno.test("resolve failure does not undo the recorded receivable", async () => {
  const db = fakeDb({ resolve: true });
  const out = await ensureShortfallReceivableOrException(db.client, input(), { log: silent });
  assertEquals(out.state, SHORTFALL_SAFETY_STATE.RECEIVABLE_RECORDED);
  assert(out.errors.some((e) => e.startsWith("resolve_exception")));
});

Deno.test("missing customer: no receivable possible, shortfall held as exception", async () => {
  const db = fakeDb();
  const out = await ensureShortfallReceivableOrException(db.client, input({ customer_id: null }), { log: silent });
  assertEquals(out.state, SHORTFALL_SAFETY_STATE.EXCEPTION_RECORDED);
  assertEquals(db.receivables.size, 0);
  assertEquals(db.exceptions.size, 1);
  assert(!db.calls.includes("customer_receivable_record_declined_increment"));
});

Deno.test("no shortfall or unknown provider state: nothing written", async () => {
  for (const patch of [
    { shortfall_pence: 0, captured_pence: 1240 },
    { provider_state: "UNKNOWN" },
  ] as Partial<ShortfallSafetyInput>[]) {
    const db = fakeDb();
    const out = await ensureShortfallReceivableOrException(db.client, input(patch), { log: silent });
    assertEquals(out.state, SHORTFALL_SAFETY_STATE.NOT_REQUIRED);
    assertEquals(db.calls.length, 0);
  }
});

Deno.test("ledger guard: pre-ledger shortfalls never become new customer debt", () => {
  assertEquals(isWithinReceivablesLedger("2026-08-08T12:00:00Z"), false);
  assertEquals(isWithinReceivablesLedger("2026-09-23T00:00:00Z"), true);
  assertEquals(isWithinReceivablesLedger(null), false);
  assertEquals(isWithinReceivablesLedger("garbage"), false);
});

Deno.test("session marker parsing", () => {
  assertEquals(shortfallPenceFromSessionMarker({ metadata: { shortfall_pence: 36 } }), 36);
  assertEquals(shortfallPenceFromSessionMarker({ metadata: { shortfall_pence: "6" } }), 6);
  assertEquals(shortfallPenceFromSessionMarker({ metadata: {} }), 0);
  assertEquals(shortfallPenceFromSessionMarker({ metadata: { shortfall_pence: -5 } }), 0);
  assertEquals(shortfallPenceFromSessionMarker(null), 0);
});
