/**
 * Session-owned initial_auth ledger writers + structured failure diagnostics.
 * Pairs with supabase/tests/payment_authorization_ledger_session_owner.sh (database side).
 */
import { assert, assertEquals, assertFalse, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildPreauthIdempotencyKey, recordPaymentAuthorizationEvent } from "./dynamicPaymentWorkflow.ts";
import {
  buildPaymentLedgerWriteFailedEvent,
  classifyPaymentLedgerError,
  PaymentLedgerWriteError,
  reportPaymentLedgerWriteFailure,
} from "./paymentLedgerDiagnostics.ts";

const SESSION = "11111111-1111-1111-1111-111111111111";
const TRIP = "33333333-3333-3333-3333-333333333333";
const CAI = "fbd1cb98-ba29-4c88-810f-c03e9dc1d52d";
const ORDER = "6abff7a0-80f3-a88b-90db-3dee98c9bc96";

function fakeSupabase(result: { error: unknown } = { error: null }) {
  const inserts: Array<Record<string, unknown>> = [];
  const tables: string[] = [];
  return {
    inserts,
    tables,
    client: {
      from(table: string) {
        tables.push(table);
        return {
          insert(row: Record<string, unknown>) {
            inserts.push(row);
            return Promise.resolve(result);
          },
        };
      },
    } as never,
  };
}

const base = {
  fareRevisionNumber: 0,
  operation: "initial_auth" as const,
  idempotencyKey: `preauth_${CAI}`,
  providerOrderId: ORDER,
  amountPence: 750,
  status: "pending" as const,
};

Deno.test("pre-trip write: session owner, trip_id null, order column set", async () => {
  const db = fakeSupabase();
  const r = await recordPaymentAuthorizationEvent(db.client, { ...base, tripId: null, paymentSessionId: SESSION });
  assertEquals(r.duplicate, false);
  assertEquals(db.inserts.length, 1);
  const row = db.inserts[0];
  assertEquals(row.trip_id, null);
  assertEquals(row.payment_session_id, SESSION);
  assertEquals(row.provider_order_id, ORDER);
  assertEquals(row.idempotency_key, `preauth_${CAI}`);
});

Deno.test("no fake trip id: ownerless write is rejected before any database call", async () => {
  const db = fakeSupabase();
  const err = await assertRejects(
    () => recordPaymentAuthorizationEvent(db.client, { ...base, tripId: null, paymentSessionId: null }),
    PaymentLedgerWriteError,
  );
  assertEquals(err.classification.error_category, "owner_missing");
  assertEquals(db.tables.length, 0);
});

Deno.test("top_up / capture without a trip are rejected (session ownership is initial_auth only)", async () => {
  for (const operation of ["top_up", "capture"] as const) {
    const db = fakeSupabase();
    await assertRejects(
      () => recordPaymentAuthorizationEvent(db.client, { ...base, operation, tripId: null, paymentSessionId: SESSION }),
      PaymentLedgerWriteError,
    );
    assertEquals(db.inserts.length, 0);
  }
});

Deno.test("trip-owned write (CTAP) stays schema-agnostic: no session columns sent", async () => {
  const db = fakeSupabase();
  await recordPaymentAuthorizationEvent(db.client, { ...base, tripId: TRIP, status: "succeeded" });
  const row = db.inserts[0];
  assertEquals(row.trip_id, TRIP);
  assertFalse("payment_session_id" in row);
  assertFalse("provider_order_id" in row);
  assertEquals((row.metadata as Record<string, unknown>).provider_order_id, ORDER);
});

Deno.test("duplicate initial_auth (23505) is idempotent, not an error", async () => {
  const db = fakeSupabase({ error: { code: "23505", message: 'duplicate key value violates unique constraint "payment_authorization_ledger_idempotency_key_key"' } });
  const r = await recordPaymentAuthorizationEvent(db.client, { ...base, tripId: null, paymentSessionId: SESSION });
  assertEquals(r.duplicate, true);
});

Deno.test("FK failure → typed error with code, category, constraint; never [object Object]", async () => {
  const pgErr = {
    code: "23503",
    message: 'insert or update on table "payment_authorization_ledger" violates foreign key constraint "payment_authorization_ledger_trip_id_fkey"',
    details: `Key (trip_id)=(${CAI}) is not present in table "trips".`,
  };
  const db = fakeSupabase({ error: pgErr });
  const err = await assertRejects(
    () => recordPaymentAuthorizationEvent(db.client, { ...base, tripId: TRIP }),
    PaymentLedgerWriteError,
  );
  assertEquals(err.classification, {
    error_code: "23503",
    error_category: "fk_violation",
    constraint: "payment_authorization_ledger_trip_id_fkey",
    column: null,
  });
  assertFalse(String(err).includes("[object Object]"));
  assertFalse(err.message.includes(CAI), "row values from details must not leak");
});

Deno.test("pre-migration schema (PGRST204 unknown column) is classified, not swallowed", () => {
  const c = classifyPaymentLedgerError({
    code: "PGRST204",
    message: "Could not find the 'payment_session_id' column of 'payment_authorization_ledger' in the schema cache",
  });
  assertEquals(c.error_category, "undefined_column");
  assertEquals(c.column, "payment_session_id");
});

Deno.test("classification: check, not-null, RLS, network, unknown", () => {
  assertEquals(classifyPaymentLedgerError({ code: "23514", message: 'violates check constraint "payment_authorization_ledger_owner_chk"' }).constraint, "payment_authorization_ledger_owner_chk");
  assertEquals(classifyPaymentLedgerError({ code: "23502", message: 'null value in column "trip_id" of relation "x" violates not-null constraint' }).column, "trip_id");
  assertEquals(classifyPaymentLedgerError({ code: "42501", message: "new row violates row-level security policy" }).error_category, "permission_denied");
  assertEquals(classifyPaymentLedgerError(new TypeError("error sending request: connection reset")).error_category, "network");
  assertEquals(classifyPaymentLedgerError("weird").error_category, "unknown");
  assertEquals(classifyPaymentLedgerError(null).error_category, "unknown");
});

Deno.test("structured failure log: identifiers + classification only, single JSON line", () => {
  const lines: string[] = [];
  const event = reportPaymentLedgerWriteFailure({
    operation: "initial_auth",
    stage: "create_preauth_pending",
    paymentSessionId: SESSION,
    clientActionId: CAI,
    tripId: null,
    providerOrderId: ORDER,
    consequence: "booking_continues_session_trigger_backstop",
  }, {
    code: "23503",
    message: 'violates foreign key constraint "payment_authorization_ledger_payment_session_id_fkey"',
    details: "Key (payment_session_id)=(secret-row-value) card_token=tok_live_abc fingerprint_html=PGh0bWw+",
    hint: "amount_pence=750",
  }, (l) => lines.push(l));
  assertEquals(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assertEquals(parsed, event);
  assertEquals(parsed.event, "PAYMENT_LEDGER_WRITE_FAILED");
  assertEquals(parsed.operation, "initial_auth");
  assertEquals(parsed.stage, "create_preauth_pending");
  assertEquals(parsed.payment_session_id, SESSION);
  assertEquals(parsed.client_action_id, CAI);
  assertEquals(parsed.provider_order_id, ORDER);
  assertEquals(parsed.error_code, "23503");
  assertEquals(parsed.error_category, "fk_violation");
  assertEquals(parsed.constraint, "payment_authorization_ledger_payment_session_id_fkey");
  for (const leak of ["[object Object]", "secret-row-value", "tok_live_abc", "fingerprint_html", "PGh0bWw", "amount_pence", "750"]) {
    assertFalse(lines[0].includes(leak), `leaked ${leak}`);
  }
});

Deno.test("typed error re-classifies to itself (no double wrapping)", () => {
  const e = new PaymentLedgerWriteError({ error_code: "23514", error_category: "check_violation", constraint: "c", column: null });
  const ev = buildPaymentLedgerWriteFailedEvent({ operation: "initial_auth", stage: "s", consequence: "x" }, e);
  assertEquals(ev.error_category, "check_violation");
  assertEquals(ev.constraint, "c");
});

Deno.test("CTAP and create-preauth share the session key for the same booking", () => {
  assertEquals(buildPreauthIdempotencyKey({ clientActionId: CAI }), `preauth_${CAI}`);
  const ctap = Deno.readTextFileSync(new URL("./bookingPostCommit.ts", import.meta.url));
  assert(ctap.includes("? { clientActionId: ctx.body.client_action_id }"), "CTAP keys by client_action_id when present");
  assert(ctap.includes("reportPaymentLedgerWriteFailure"));
  assertFalse(ctap.includes('ctx.log("post-commit auth ledger warning", { error: String(e) })'));
});

Deno.test("create-preauth writer: session owner, no client_action_id as trip_id, failure reported", () => {
  const src = Deno.readTextFileSync(new URL("./revolutPreauth.ts", import.meta.url));
  const at = src.indexOf("await recordPaymentAuthorizationEvent");
  assert(at > 0);
  const block = src.slice(at, at + 1400);
  assert(block.includes("tripId: tripId ?? null"));
  assert(block.includes("paymentSessionId: paymentSessionId ?? null"));
  assert(block.includes("reportPaymentLedgerWriteFailure"));
  assertFalse(src.includes('tripId ?? clientActionId ?? "pending"'));
  assertFalse(block.includes("String(err)"));
});

Deno.test("corporate booking goes through the same session-owned create-preauth writer", () => {
  const src = Deno.readTextFileSync(new URL("../create-corporate-book/index.ts", import.meta.url));
  const call = src.indexOf("createRevolutPreauthResponse({");
  assert(call > 0);
  const args = src.slice(call, call + 900);
  assert(args.includes("tripId: null"));
  assert(args.includes("clientActionId"));
});
