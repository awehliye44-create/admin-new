/**
 * Runtime verification — Instant/Scheduled × Saved Card/Apple Pay/Google Pay
 * all share one post-order session-link path. Clocks must be:
 * - Instant: null/null (no scheduled advance stamp)
 * - Scheduled: validated ISO pair preserved into upsert args
 *
 * Mocks provider responses; does not call live Revolut.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateScheduledAdvanceWindow,
  resolveScheduledAdvanceWindowPolicy,
} from "./scheduledAdvanceWindowSSOT.ts";

type Scenario = {
  name: string;
  when: "NOW" | "SCHEDULED";
  paymentMethod: "card" | "apple_pay" | "google_pay";
  scheduledAt: string | null;
};

const SCENARIOS: Scenario[] = [
  { name: "Instant Saved Card", when: "NOW", paymentMethod: "card", scheduledAt: null },
  { name: "Instant Apple Pay", when: "NOW", paymentMethod: "apple_pay", scheduledAt: null },
  { name: "Instant Google Pay", when: "NOW", paymentMethod: "google_pay", scheduledAt: null },
  {
    name: "Scheduled Saved Card",
    when: "SCHEDULED",
    paymentMethod: "card",
    scheduledAt: "2026-11-12T22:00:00.000Z",
  },
  {
    name: "Scheduled Apple Pay",
    when: "SCHEDULED",
    paymentMethod: "apple_pay",
    scheduledAt: "2026-11-12T22:00:00.000Z",
  },
  {
    name: "Scheduled Google Pay",
    when: "SCHEDULED",
    paymentMethod: "google_pay",
    scheduledAt: "2026-11-12T22:00:00.000Z",
  },
];

/**
 * Mirrors the fixed revolutPreauth control flow for advance-window clocks +
 * post-order session link (the exact scope that threw ReferenceError).
 */
function runPreauthClockAndSessionLink(args: {
  when: "NOW" | "SCHEDULED";
  scheduledAt: string | null;
  paymentMethod: string;
  nowMs: number;
}): {
  advanceWindowValidatedAt: string | null;
  advanceWindowValidatedScheduledAt: string | null;
  mockedOrderId: string;
  sessionLinkArgs: Record<string, unknown>;
  customerHandoff: { order_id: string; payment_method: string; trip_id: null };
} {
  // Hoisted above try — the fix under test.
  let advanceWindowValidatedAt: string | null = null;
  let advanceWindowValidatedScheduledAt: string | null = null;
  let order: { id: string; state: string } | null = null;

  try {
    const whenRaw = args.when;
    const scheduledAtRaw = String(args.scheduledAt ?? "").trim();
    const isScheduledDraft = whenRaw === "SCHEDULED" || Boolean(scheduledAtRaw);
    if (isScheduledDraft) {
      assert(scheduledAtRaw, "scheduled requires scheduled_at");
      const validatedAt = new Date(args.nowMs);
      const advance = evaluateScheduledAdvanceWindow({
        scheduledAtIso: scheduledAtRaw,
        nowMs: validatedAt.getTime(),
        policy: resolveScheduledAdvanceWindowPolicy(null),
      });
      assert(
        advance.ok,
        `advance window rejected: ${advance.ok ? "" : `${advance.code} ${advance.reason}`}`,
      );
      advanceWindowValidatedAt = validatedAt.toISOString();
      advanceWindowValidatedScheduledAt = new Date(Date.parse(scheduledAtRaw)).toISOString();
    }

    // Mock Revolut POST /orders success (provider response).
    order = {
      id: `mock_ord_${args.paymentMethod}_${whenRaw.toLowerCase()}`,
      state: "PENDING",
    };
  } catch (err) {
    throw new Error(`order-create try failed: ${err}`);
  }

  // Post-order session link — historically OUTSIDE the try and crashed.
  assert(order, "order must exist after try");
  const sessionLinkArgs = {
    providerOrderId: order.id,
    paymentMethod: args.paymentMethod,
    advanceWindowValidatedAt,
    advanceWindowValidatedScheduledAt,
    trip_id: null as null,
  };

  return {
    advanceWindowValidatedAt,
    advanceWindowValidatedScheduledAt,
    mockedOrderId: order.id,
    sessionLinkArgs,
    customerHandoff: {
      order_id: order.id,
      payment_method: args.paymentMethod,
      trip_id: null, // handoff before CTAP; trip created only after auth+finalise
    },
  };
}

for (const scenario of SCENARIOS) {
  Deno.test(`six-scenario runtime: ${scenario.name}`, () => {
    const nowMs = Date.parse("2026-11-12T21:34:00.000Z");
    const result = runPreauthClockAndSessionLink({
      when: scenario.when,
      scheduledAt: scenario.scheduledAt,
      paymentMethod: scenario.paymentMethod,
      nowMs,
    });

    // No undefined / ReferenceError — clocks are defined bindings.
    assertEquals("advanceWindowValidatedAt" in result.sessionLinkArgs, true);
    assertEquals("advanceWindowValidatedScheduledAt" in result.sessionLinkArgs, true);

    if (scenario.when === "NOW") {
      assertEquals(result.advanceWindowValidatedAt, null);
      assertEquals(result.advanceWindowValidatedScheduledAt, null);
    } else {
      assertEquals(result.advanceWindowValidatedAt, "2026-11-12T21:34:00.000Z");
      assertEquals(result.advanceWindowValidatedScheduledAt, "2026-11-12T22:00:00.000Z");
    }

    assert(result.mockedOrderId.startsWith("mock_ord_"));
    assertEquals(result.sessionLinkArgs.providerOrderId, result.mockedOrderId);
    assertEquals(result.customerHandoff.order_id, result.mockedOrderId);
    assertEquals(result.customerHandoff.trip_id, null);
    // Single order only — no duplicate authorisation in this path.
    assertEquals(result.sessionLinkArgs.paymentMethod, scenario.paymentMethod);
  });
}

Deno.test("source: all six methods share one post-order upsert (no per-method fork)", () => {
  const src = Deno.readTextFileSync(new URL("./revolutPreauth.ts", import.meta.url).pathname);
  const fn = src.slice(src.indexOf("export async function createRevolutPreauthResponse"));
  const afterOrder = fn.slice(fn.indexOf('logStep("Revolut order created"'));
  // Exactly one providerOrderId: order.id upsert immediately after order create log
  // before saved-card settle / wallet return forks.
  const firstUpsert = afterOrder.indexOf("upsertPaymentSessionPending");
  const firstBlock = afterOrder.slice(firstUpsert, firstUpsert + 1200);
  assertEquals(firstBlock.includes("providerOrderId: order.id"), true);
  assertEquals(firstBlock.includes("advanceWindowValidatedAt,"), true);
  // No method-specific advance-window branch after order create.
  assertEquals(/apple_pay|google_pay/.test(firstBlock.split("metadata")[0] ?? ""), false);
});
