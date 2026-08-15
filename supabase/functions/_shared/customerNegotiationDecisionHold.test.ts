/**
 * Timely Customer fare decision must beat timeout while increment reconciles.
 * Run: deno test --allow-read supabase/functions/_shared/customerNegotiationDecisionHold.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  customerSubmittedBeforeDeadline,
  shouldTimeoutAbandonedDecisionHold,
  shouldTimeoutWaitingCustomer,
} from "./customerNegotiationDecisionHold.ts";

const deadline = Date.parse("2026-08-15T13:39:29.877Z");

Deno.test("A/B — timely Accept keeps timeout from winning while increment is in flight", () => {
  const submittedAt = deadline - 500;
  assertEquals(customerSubmittedBeforeDeadline({ submittedAtMs: submittedAt, deadlineMs: deadline }), true);
  assertEquals(
    shouldTimeoutWaitingCustomer({
      negotiationStatus: "waiting_customer",
      customerRespondByIso: "2026-08-15T13:39:29.877Z",
      respondedAtIso: new Date(submittedAt).toISOString(),
      nowMs: deadline + 2000,
    }),
    false,
  );
});

Deno.test("C — timely Counter uses the same hold after the deadline", () => {
  assertEquals(
    shouldTimeoutWaitingCustomer({
      negotiationStatus: "waiting_customer",
      customerRespondByIso: "2026-08-15T13:39:29.877Z",
      respondedAtIso: "2026-08-15T13:39:15.649Z",
      nowMs: deadline + 1500,
    }),
    false,
  );
});

Deno.test("D/H — pending increment + responded_at: timeout worker must skip", () => {
  assertEquals(
    shouldTimeoutWaitingCustomer({
      negotiationStatus: "waiting_customer",
      customerRespondByIso: "2026-08-15T13:39:29.877Z",
      respondedAtIso: "2026-08-15T13:39:15.649Z",
      nowMs: Date.parse("2026-08-15T13:39:39.586Z"),
    }),
    false,
  );
});

Deno.test("F — no Customer action before deadline still times out", () => {
  assertEquals(
    shouldTimeoutWaitingCustomer({
      negotiationStatus: "waiting_customer",
      customerRespondByIso: "2026-08-15T13:39:29.877Z",
      respondedAtIso: null,
      nowMs: deadline + 1,
    }),
    true,
  );
});

Deno.test("action after deadline remains a valid timeout", () => {
  assertEquals(
    customerSubmittedBeforeDeadline({ submittedAtMs: deadline + 200, deadlineMs: deadline }),
    false,
  );
  assertEquals(
    shouldTimeoutWaitingCustomer({
      negotiationStatus: "waiting_customer",
      customerRespondByIso: "2026-08-15T13:39:29.877Z",
      respondedAtIso: null,
      nowMs: deadline + 200,
    }),
    true,
  );
});

Deno.test("abandoned in-flight hold uses the existing 90s stuck backstop", () => {
  const responded = deadline - 500;
  assertEquals(
    shouldTimeoutAbandonedDecisionHold({
      negotiationStatus: "waiting_customer",
      respondedAtIso: new Date(responded).toISOString(),
      nowMs: responded + 2_000,
    }),
    false,
  );
  assertEquals(
    shouldTimeoutAbandonedDecisionHold({
      negotiationStatus: "waiting_customer",
      respondedAtIso: new Date(responded).toISOString(),
      nowMs: responded + 90_000,
    }),
    true,
  );
});

Deno.test("SQL cron_sweep must skip in-flight responded_at holds", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260925120000_negotiation_decision_hold_sql_timeout.sql",
      import.meta.url,
    ),
  );
  assertEquals(sql.includes("expire_stale_negotiations"), true);
  assertEquals(sql.includes("responded_at IS NULL"), true);
  assertEquals(sql.includes("interval '90 seconds'"), true);
  assertEquals(sql.includes("cron_sweep"), true);
});

Deno.test("expire-offers and sync skip in-flight responded_at holds", async () => {
  const expire = await Deno.readTextFile(new URL("../expire-offers/index.ts", import.meta.url));
  const sync = await Deno.readTextFile(
    new URL("../customer-negotiation-sync/index.ts", import.meta.url),
  );
  const decision = await Deno.readTextFile(
    new URL("../customer-fare-decision/index.ts", import.meta.url),
  );
  assertEquals(expire.includes("shouldTimeoutWaitingCustomer"), true);
  assertEquals(expire.includes("shouldTimeoutAbandonedDecisionHold"), true);
  assertEquals(sync.includes("shouldTimeoutWaitingCustomer"), true);
  assertEquals(decision.includes("claimCustomerNegotiationDecision"), true);
  const acceptStart = decision.indexOf('if (action === "ACCEPT" || action === "COUNTER")');
  const firstCover = decision.indexOf("ensureNegotiationPayableAuthorised({");
  assertEquals(acceptStart > 0 && firstCover > acceptStart, true);
  assertEquals(
    decision.indexOf("claimCustomerNegotiationDecision", acceptStart) < firstCover,
    true,
  );
});
