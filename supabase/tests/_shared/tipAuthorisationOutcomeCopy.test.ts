/**
 * Tip copy invariant (CUSTOMER_SUBMIT_WITH_TIP):
 *   provider DECLINED (with provider decline evidence) → bank/issuer wording allowed
 *   authorised total merely below target, no decline evidence → neutral
 *   provider FAILED    → never "bank declined"
 *   unknown / missing  → never an invented bank/issuer reason
 * Financial behaviour is unchanged: no fare capture, internal status stays
 * TIP_AUTHORISATION_DECLINED so submit-customer-trip-tip keeps the window open.
 */
import { assert, assertEquals, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  normalizeTipAuthorisationOutcome,
  TIP_AUTHORISATION_DECLINED_COPY,
  tipAuthorisationCustomerCopy,
  tipAuthorisationCustomerErrorCode,
  tipAuthorisationOutcomeFromIncrementKind,
} from "../../functions/_shared/tipAuthorisationOutcomeSSOT.ts";
import { executeRevolutTripCompletionCapture } from "../../functions/_shared/revolutCompletionCapture.ts";
import { asSupabase, InMemorySupabase, stubFetch } from "./support/inMemorySupabase.ts";

const BANK_WORDING = /\b(bank|issuer)\b|declin/i;

Deno.test("tip copy: provider declined → decline message and TIP_AUTHORISATION_DECLINED", () => {
  for (const evidence of ["provider_increment_declined", "provider_http_declined"]) {
    const outcome = tipAuthorisationOutcomeFromIncrementKind("declined", evidence);
    assertEquals(outcome, "declined");
    assertEquals(tipAuthorisationCustomerCopy(outcome), TIP_AUTHORISATION_DECLINED_COPY);
    assert(/bank declined the tip/i.test(tipAuthorisationCustomerCopy(outcome)));
    assertEquals(tipAuthorisationCustomerErrorCode(outcome), "TIP_AUTHORISATION_DECLINED");
  }
});

Deno.test("tip copy: declined kind without provider decline evidence → neutral, never bank declined", () => {
  for (const evidence of [undefined, null, ""]) {
    const outcome = tipAuthorisationOutcomeFromIncrementKind("declined", evidence);
    assertEquals(outcome, "unknown", String(evidence));
    assertStrictEquals(BANK_WORDING.test(tipAuthorisationCustomerCopy(outcome)), false);
    assertEquals(tipAuthorisationCustomerErrorCode(outcome), "CAPTURE_FAILED");
  }
});

Deno.test("tip copy: provider_failed → neutral technical message, never bank/declined", () => {
  const outcome = tipAuthorisationOutcomeFromIncrementKind("provider_failed");
  assertEquals(outcome, "provider_failed");
  const copy = tipAuthorisationCustomerCopy(outcome);
  assertStrictEquals(BANK_WORDING.test(copy), false, copy);
  assert(copy.startsWith("We couldn't authorise the tip payment."));
  assertEquals(tipAuthorisationCustomerErrorCode(outcome), "CAPTURE_FAILED");
});

Deno.test("tip copy: unknown / missing / non-decline kinds → neutral message", () => {
  for (const kind of ["unsupported", "provider_limit", "ineligible", "unknown", "", null, undefined]) {
    const outcome = tipAuthorisationOutcomeFromIncrementKind(kind as string | null | undefined);
    assertEquals(outcome, "unknown", String(kind));
    assertStrictEquals(BANK_WORDING.test(tipAuthorisationCustomerCopy(outcome)), false);
    assertEquals(tipAuthorisationCustomerErrorCode(outcome), "CAPTURE_FAILED");
  }
  for (const raw of [undefined, null, "", "DECLINED_BY_BANK", 42, { declined: true }]) {
    const outcome = normalizeTipAuthorisationOutcome(raw);
    assertEquals(outcome, "unknown", JSON.stringify(raw));
    assertEquals(tipAuthorisationCustomerErrorCode(outcome), "CAPTURE_FAILED");
  }
  assertEquals(normalizeTipAuthorisationOutcome(" Declined "), "declined");
  assertEquals(normalizeTipAuthorisationOutcome("provider_failed"), "provider_failed");
});

// --- Behavioural: completion capture with a tip that needs a same-order increment ---

const TRIP_ID = "77777777-7777-4777-8777-777777777777";
const SESSION_ID = "88888888-8888-4888-8888-888888888888";
const CLIENT_ACTION_ID = "99999999-9999-4999-8999-999999999999";
const ORDER_ID = "ord_tip_increment";
const FARE = 1500;
const TIP = 300;

function order(increment: Record<string, unknown> | null) {
  return {
    id: ORDER_ID,
    state: "AUTHORISED",
    capture_mode: "manual",
    amount: FARE,
    currency: "GBP",
    payments: [{
      id: "pay_1",
      state: "AUTHORISED",
      amount: FARE,
      authorised_amount: FARE,
      payment_method: { type: "card", card_brand: "visa" },
    }],
    incremental_authorisations: increment ? [increment] : [],
  };
}

type PostReply = { status: number; body: Record<string, unknown> };

async function captureWithTip(
  increment: (reference: string) => Record<string, unknown> | null,
  postReply?: (reference: string) => PostReply,
) {
  Deno.env.set("REVOLUT_MERCHANT_SECRET_KEY", "sk_fixture_unit_test_only_0000000000");
  const db = new InMemorySupabase({
    tables: {
      trips: [{
        id: TRIP_ID,
        trip_code: "MK-TEST-TIP",
        status: "completed",
        provider_order_id: ORDER_ID,
        client_action_id: CLIENT_ACTION_ID,
        financial_model: "PLATFORM_COLLECTED",
        final_fare_pence: FARE,
        authorised_amount_pence: FARE,
        capture_amount_pence: null,
        payment_status: "authorised",
        currency_code: "GBP",
      }],
      payment_sessions: [{
        id: SESSION_ID,
        client_action_id: CLIENT_ACTION_ID,
        provider_order_id: ORDER_ID,
        trip_id: TRIP_ID,
        purpose: "TRIP_PAYMENT",
        status: "authorised_hold",
        authorised_amount_pence: FARE,
        total_authorised_amount_pence: FARE,
        captured_amount_pence: null,
        currency: "GBP",
        metadata: {},
        financial_operation_state: "IDLE",
        financial_operation_owner: null,
        financial_operation_started_at: null,
        created_at: "2026-10-02T10:00:00.000Z",
      }],
      payment_session_authorisations: [],
      payments: [],
      payment_provider_vault: [],
    },
    rpc: {
      assert_trip_completion_customer_payment_gate: () => ({ data: { ok: true }, error: null }),
    },
  });
  let posted = false;
  let reference = "";
  const fetchStub = stubFetch((call) => {
    if (call.method === "POST" && call.url.endsWith(`/orders/${ORDER_ID}/increment-authorisation`)) {
      posted = true;
      reference = String((call.body as Record<string, unknown>)?.reference ?? "");
      return postReply ? postReply(reference) : { status: 200, body: order(increment(reference)) };
    }
    if (call.method === "GET" && call.url.endsWith(`/orders/${ORDER_ID}`)) {
      return { status: 200, body: order(posted ? increment(reference) : null) };
    }
    return { status: 500, body: { message: `unexpected ${call.method} ${call.url}` } };
  });
  try {
    const result = await executeRevolutTripCompletionCapture({
      supabase: asSupabase(db),
      trip: { ...db.rows("trips")[0] },
      tipPence: TIP,
    });
    return { result: result as Record<string, unknown>, db, calls: fetchStub.calls };
  } finally {
    fetchStub.restore();
    Deno.env.delete("REVOLUT_MERCHANT_SECRET_KEY");
  }
}

function assertNoFareCapture(r: Awaited<ReturnType<typeof captureWithTip>>) {
  assertEquals(r.result.success, false);
  assertEquals(r.result.status, "TIP_AUTHORISATION_DECLINED");
  assertEquals(r.result.error_code, "TIP_AUTHORISATION_DECLINED");
  assertEquals(r.result.capture_amount_pence, 0);
  assert(!r.calls.some((c) => c.url.includes("/capture")), "fare must not be captured");
  assertEquals(r.calls.filter((c) => c.method === "POST").length, 1, "exactly one increment POST");
  assertEquals((r.db.rows("payment_sessions")[0] as Record<string, unknown>).total_authorised_amount_pence, FARE);
}

Deno.test("completion capture: tip increment declined → decline copy, no fare capture", async () => {
  const r = await captureWithTip((ref) => ({
    state: "declined", reason: "insufficient_funds", old_amount: FARE, new_amount: FARE + TIP, reference: ref,
  }));
  assertNoFareCapture(r);
  assertEquals(r.result.tip_authorisation_outcome, "declined");
  assertEquals(r.result.error, TIP_AUTHORISATION_DECLINED_COPY);
});

Deno.test("completion capture: tip increment failed → neutral copy, never bank declined, no fare capture", async () => {
  const r = await captureWithTip((ref) => ({
    state: "failed", reason: "technical_error", old_amount: FARE, new_amount: FARE + TIP, reference: ref,
  }));
  assertNoFareCapture(r);
  assertEquals(r.result.tip_authorisation_outcome, "provider_failed");
  assertStrictEquals(BANK_WORDING.test(String(r.result.error)), false, String(r.result.error));
});

Deno.test("completion capture: total below target but no provider decline → neutral copy, no fare capture", async () => {
  // POST answers 200 without raising the authorised total and Revolut records no
  // declined increment: nothing evidences an issuer decline.
  const r = await captureWithTip(() => null);
  assertNoFareCapture(r);
  assertEquals(r.result.tip_authorisation_outcome, "unknown");
  assertStrictEquals(BANK_WORDING.test(String(r.result.error)), false, String(r.result.error));
});

Deno.test("completion capture: increment POST rejected as declined by Revolut → decline copy, no fare capture", async () => {
  const r = await captureWithTip(
    () => null,
    () => ({ status: 422, body: { code: "card_declined", message: "Card declined" } }),
  );
  assertNoFareCapture(r);
  assertEquals(r.result.tip_authorisation_outcome, "declined");
  assertEquals(r.result.error, TIP_AUTHORISATION_DECLINED_COPY);
});

Deno.test("submit-customer-trip-tip: customer code/copy come from finalize's provider outcome only", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/submit-customer-trip-tip/index.ts", import.meta.url),
  );
  const branch = src.slice(src.indexOf('outcome.kind === "tip_authorisation_declined"'));
  const block = branch.slice(0, branch.indexOf("\n      }\n"));
  assert(block.includes("normalizeTipAuthorisationOutcome(") && block.includes("rec.body?.tip_authorisation_outcome"));
  assert(block.includes("error: tipAuthorisationCustomerCopy(tipAuthorisationOutcome)"));
  assert(block.includes("error_code: tipAuthorisationCustomerErrorCode(tipAuthorisationOutcome)"));
  assert(block.includes("tip_window_status: TIP_WINDOW_STATUS.OPEN"));
  assert(block.includes("fare_captured: false"));
  assert(block.includes("releaseTipWindowTriggerClaim("));
  assertStrictEquals(block.includes("TIP_AUTHORISATION_DECLINED_CUSTOMER_MESSAGE"), false);
});
