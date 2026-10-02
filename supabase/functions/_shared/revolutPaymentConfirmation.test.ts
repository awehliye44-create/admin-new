/**
 * verifyRevolutOrderConfirmedForBooking: the provider order read is the only authority.
 * Deterministic — fake clock, fake sleep, scripted provider reads.
 */
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { RevolutOrder } from "./revolutOrders.ts";
import {
  type RevolutConfirmCheckEvent,
  type RevolutConfirmResolvedEvent,
  verifyRevolutOrderConfirmedForBooking,
} from "./revolutPaymentConfirmation.ts";

type Step = { state?: string; error?: number; getMs?: number; extra?: Partial<RevolutOrder> };

function harness(steps: Step[]) {
  let t = 1_000_000;
  let inFlight = 0;
  let maxConcurrent = 0;
  const events: Array<RevolutConfirmCheckEvent | RevolutConfirmResolvedEvent> = [];
  const sleeps: number[] = [];
  const invariant: unknown[] = [];
  const dbCalls: string[] = [];
  let i = 0;
  const supabase = new Proxy({}, {
    get: (_t, prop) => {
      dbCalls.push(String(prop));
      throw new Error(`verifier must not touch the database (${String(prop)})`);
    },
  });
  const deps = {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
      await Promise.resolve();
    },
    emit: (e: RevolutConfirmCheckEvent | RevolutConfirmResolvedEvent) => events.push(e),
    onInvariantViolation: async (_s: unknown, args: unknown) => {
      invariant.push(args);
    },
    retrieve: async (_env: unknown, _key: string, orderId: string): Promise<RevolutOrder> => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      await Promise.resolve();
      t += step.getMs ?? 150;
      inFlight -= 1;
      if (step.error != null) {
        throw Object.assign(new Error("provider"), { status: step.error });
      }
      return { id: orderId, state: step.state, ...(step.extra ?? {}) } as RevolutOrder;
    },
  };
  return {
    supabase,
    deps,
    events,
    sleeps,
    invariant,
    dbCalls,
    gets: () => i,
    maxConcurrent: () => maxConcurrent,
    checks: () => events.filter((e): e is RevolutConfirmCheckEvent => e.event === "REVOLUT_CONFIRM_CHECK"),
    resolved: () => events.filter((e): e is RevolutConfirmResolvedEvent => e.event === "REVOLUT_CONFIRM_RESOLVED"),
  };
}

function run(h: ReturnType<typeof harness>, opts: { maxWaitMs: number; pollIntervalMs: number; caller?: string; seq?: number | null }) {
  return verifyRevolutOrderConfirmedForBooking(
    h.supabase as never,
    "test",
    "sk_test",
    "order-1",
    { maxWaitMs: opts.maxWaitMs, pollIntervalMs: opts.pollIntervalMs, caller: opts.caller ?? "confirm-revolut-payment", clientRequestSeq: opts.seq ?? null },
    h.deps as never,
  );
}

Deno.test("AUTHORISED on the immediate read → confirmed via api, one GET, no DB", async () => {
  const h = harness([{ state: "AUTHORISED" }]);
  const r = await run(h, { maxWaitMs: 2000, pollIntervalMs: 400 });
  assert(r.ok);
  if (r.ok) assertEquals(r.confirmed_via, "api");
  assertEquals(h.gets(), 1);
  assertEquals(h.dbCalls, []);
  assertEquals(h.resolved()[0].resolution, "api_authorised");
  assertEquals(h.resolved()[0].resolution_owner, "provider_api");
});

Deno.test("PENDING then AUTHORISED within the deadline → confirmed after polling", async () => {
  const h = harness([{ state: "PENDING" }, { state: "PROCESSING" }, { state: "AUTHORISED" }]);
  const r = await run(h, { maxWaitMs: 2000, pollIntervalMs: 400 });
  assert(r.ok);
  assertEquals(h.gets(), 3);
  assertEquals(h.checks().map((c) => c.phase), ["immediate", "poll", "poll"]);
  assertEquals(h.checks().map((c) => c.check_no), [1, 2, 3]);
});

Deno.test("decline (FAILED / CANCELLED) → not authorised, stops polling", async () => {
  for (const state of ["FAILED", "CANCELLED"]) {
    const h = harness([{ state: "PENDING" }, { state }]);
    const r = await run(h, { maxWaitMs: 2000, pollIntervalMs: 400 });
    assertFalse(r.ok);
    if (!r.ok) assert(r.reason.includes(state));
    assertEquals(h.gets(), 2);
    assertEquals(h.resolved()[0].resolution, "provider_not_authorised");
  }
});

Deno.test("COMPLETED before trip completion → invariant violation, never confirmed", async () => {
  const h = harness([{ state: "COMPLETED" }]);
  const r = await run(h, { maxWaitMs: 2000, pollIntervalMs: 400 });
  assertFalse(r.ok);
  assertEquals(h.invariant.length, 1);
  assertEquals(h.resolved()[0].resolution, "invariant_violation");
});

Deno.test("ACS / fingerprint challenge pending → stays in flight, no synthetic AUTHORISED", async () => {
  const challenge = {
    payments: [{
      id: "p1",
      state: "AUTHENTICATION_CHALLENGE",
      token: "tok_secret_card",
      authentication_challenge: { type: "three_ds_fingerprint", fingerprint_html: "PGh0bWw+c2VjcmV0", acs_url: "https://acs.example/x" },
    }],
  } as unknown as Partial<RevolutOrder>;
  const h = harness([{ state: "PENDING", extra: challenge }]);
  const r = await run(h, { maxWaitMs: 1200, pollIntervalMs: 400 });
  assertFalse(r.ok);
  if (!r.ok) {
    assertEquals(r.order?.state, "PENDING");
    assert(r.reason.includes("still processing"));
  }
  assertEquals(h.resolved()[0].resolution, "deadline_in_flight");
  const wire = JSON.stringify(h.events);
  for (const secret of ["fingerprint_html", "PGh0bWw+c2VjcmV0", "acs_url", "tok_secret_card", "sk_test", "amount"]) {
    assertFalse(wire.includes(secret), `telemetry leaked ${secret}`);
  }
});

Deno.test("deadline: last sleep is cut to the deadline; no trailing sleep + extra GET", async () => {
  const h = harness([{ state: "PENDING", getMs: 100 }]);
  await run(h, { maxWaitMs: 1000, pollIntervalMs: 400 });
  const checks = h.checks();
  assertEquals(checks.map((c) => c.phase).includes("final"), false);
  assertEquals(h.sleeps.every((s) => s <= 400), true);
  const last = checks[checks.length - 1];
  assert(last.deadline_passed);
  // Final GET begins at or before the deadline (overrun bounded by one GET duration).
  assert(last.check_offset_ms <= 1000, `last check started ${last.check_offset_ms}ms after request start`);
  const total = h.resolved()[0].total_ms;
  assert(total <= 1000 + 100, `total ${total}ms exceeds deadline + one GET`);
});

Deno.test("GET count bound: never more than 1 + ceil(maxWait/interval) + 1 reads", async () => {
  const h = harness([{ state: "PROCESSING", getMs: 0 }]);
  await run(h, { maxWaitMs: 2000, pollIntervalMs: 400 });
  assert(h.gets() <= 1 + Math.ceil(2000 / 400) + 1, `gets=${h.gets()}`);
});

Deno.test("maxWaitMs=0 (client tick) → exactly one GET", async () => {
  const h = harness([{ state: "PENDING" }]);
  const r = await run(h, { maxWaitMs: 0, pollIntervalMs: 0, seq: 3 });
  assertFalse(r.ok);
  assertEquals(h.gets(), 1);
  assertEquals(h.sleeps, []);
  assertEquals(h.checks()[0].client_request_seq, 3);
});

Deno.test("provider error then AUTHORISED → confirmed only from the provider read", async () => {
  const h = harness([{ error: 502 }, { state: "AUTHORISED" }]);
  const r = await run(h, { maxWaitMs: 2000, pollIntervalMs: 400 });
  assert(r.ok);
  assertEquals(h.checks()[0].outcome, "provider_error");
  assertEquals(h.checks()[0].provider_http_status, 502);
});

Deno.test("provider errors until deadline → not confirmed (no synthetic order)", async () => {
  const h = harness([{ error: 503 }]);
  const r = await run(h, { maxWaitMs: 1000, pollIntervalMs: 400 });
  assertFalse(r.ok);
  if (!r.ok) assertEquals(r.order, null);
  assertEquals(h.resolved()[0].resolution, "deadline_provider_error");
  assertEquals(h.checks()[h.checks().length - 1].phase, "final");
});

Deno.test("reads are strictly sequential (no overlapping provider GETs)", async () => {
  const h = harness([{ state: "PENDING" }, { state: "PENDING" }, { state: "PENDING" }, { state: "AUTHORISED" }]);
  await run(h, { maxWaitMs: 2000, pollIntervalMs: 400 });
  assertEquals(h.maxConcurrent(), 1);
});

Deno.test("CTAP caller is tagged on every check and the resolution", async () => {
  const h = harness([{ state: "PENDING" }, { state: "AUTHORISED" }]);
  await run(h, { maxWaitMs: 2000, pollIntervalMs: 400, caller: "ctap_verify_fast" });
  assertEquals(h.events.every((e) => e.caller === "ctap_verify_fast"), true);
});

Deno.test("check telemetry carries the required fields", async () => {
  const h = harness([{ state: "PENDING" }, { state: "AUTHORISED" }]);
  await run(h, { maxWaitMs: 2000, pollIntervalMs: 400, seq: 2 });
  const c = h.checks()[1];
  for (
    const k of [
      "request_id", "caller", "client_request_seq", "order_id", "check_no", "phase", "request_started_at",
      "check_started_at", "check_offset_ms", "provider_get_ms", "provider_state", "outcome", "max_wait_ms",
      "deadline_remaining_ms", "deadline_passed",
    ]
  ) {
    assert(k in c, `missing ${k}`);
  }
  assertEquals(c.provider_get_ms, 150);
  assertEquals(c.check_offset_ms, 150 + 400);
  assertEquals(h.resolved()[0].checks, 2);
});

Deno.test("source lock: verifier never reads the ledger, webhook events or builds an order", () => {
  const src = Deno.readTextFileSync(new URL("./revolutPaymentConfirmation.ts", import.meta.url));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assertFalse(code.includes(".from("), "verifier must not query tables");
  assertFalse(code.includes("processed_revolut_events"));
  assertFalse(code.includes("payment_authorization_ledger"));
  assertFalse(/state:\s*"AUTHORISED"/.test(code), "no synthetic AUTHORISED order");
  assertFalse(code.includes("ORDER_PAYMENT_AUTHENTICATED"));
  assertFalse(code.includes('confirmed_via: "webhook"'));
});
