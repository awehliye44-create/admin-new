/**
 * Direct finalize: ONE wrapper around finalize_paid_booking_session, gated by a
 * provider-read AUTHORISED order covering the full hold.
 * Run: deno test --allow-read supabase/tests/_shared/bookingDirectFinalizeSSOT.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyAutoFinalizeSession,
  directFinalizeAfterProviderAuthorised,
  directFinalizeResponseFields,
  isProviderReadAuthorisedVerifier,
  isSameBookingTrip,
  linkSameBookingTripIfMatch,
  providerOrderCoversHold,
} from "../../functions/_shared/bookingDirectFinalizeSSOT.ts";
import { createFakeSupabase } from "./fakeSupabaseForBookingFinalize.ts";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const TRIP_ID = "22222222-2222-2222-2222-222222222222";
const CUSTOMER_ID = "33333333-3333-3333-3333-333333333333";
const USER_ID = "44444444-4444-4444-4444-444444444444";
const CAI = "cai-1";
const ORDER = "ord-1";

const authorisedOrder = (authorised = 750) => ({
  id: ORDER,
  state: "AUTHORISED",
  amount: 750,
  metadata: { client_action_id: CAI },
  payments: [{ id: "pay-1", state: "AUTHORISED", authorised_amount: authorised }],
});

const session = (over: Record<string, unknown> = {}) => ({
  id: SESSION_ID,
  trip_id: null,
  status: "authorised_hold",
  metadata: {},
  purpose: "RIDE_BOOKING",
  provider_state: "AUTHORISED",
  provider_order_id: ORDER,
  client_action_id: CAI,
  user_id: USER_ID,
  customer_id: CUSTOMER_ID,
  payment_provider: "revolut",
  authorised_amount_pence: 750,
  ...over,
});

const finalizeArgs = (over: Record<string, unknown> = {}) => ({
  clientActionId: CAI,
  providerOrderId: ORDER,
  order: authorisedOrder(),
  userId: USER_ID,
  ...over,
});

Deno.test("verifier allowlist is exactly the two provider-read labels", () => {
  assert(isProviderReadAuthorisedVerifier("create_preauth_provider_read"));
  assert(isProviderReadAuthorisedVerifier("confirm_provider_read"));
  for (const v of ["markPaymentSessionAuthorised", "webhook", "", null, undefined]) {
    assert(!isProviderReadAuthorisedVerifier(v), String(v));
  }
});

Deno.test("classifyAutoFinalizeSession mirrors the webhook guard", () => {
  assertEquals(classifyAutoFinalizeSession(session()), { eligible: true, alreadyOrphaned: false });
  assertEquals(classifyAutoFinalizeSession(session({ trip_id: TRIP_ID })).eligible, false);
  for (const status of ["payment_orphaned", "orphan_authorisation"]) {
    assertEquals(classifyAutoFinalizeSession(session({ status })), { eligible: false, alreadyOrphaned: true });
  }
  assertEquals(
    classifyAutoFinalizeSession(session({ metadata: { orphan_reason: "CUSTOMER_ALREADY_HAS_ACTIVE_TRIP" } })).alreadyOrphaned,
    true,
  );
  assertEquals(classifyAutoFinalizeSession(session({ metadata: { never_capture: true } })).eligible, false);
  for (const status of ["cancelled", "failed", "released"]) {
    assertEquals(classifyAutoFinalizeSession(session({ status })).eligible, false, status);
  }
});

Deno.test("providerOrderCoversHold: AUTHORISED + authorised total >= hold (fare 500 + buffer 250)", () => {
  assert(providerOrderCoversHold(authorisedOrder(750), 750));
  assert(!providerOrderCoversHold({ ...authorisedOrder(500), amount: 500 }, 750));
  assert(!providerOrderCoversHold({ ...authorisedOrder(), state: "PENDING" }, 750));
  assert(!providerOrderCoversHold({ ...authorisedOrder(), state: "PROCESSING" }, 750));
  assert(!providerOrderCoversHold(authorisedOrder(), 0));
  assert(!providerOrderCoversHold(null, 750));
  // Webhook-ledger synthetic order carries no amount → never coverage.
  assert(!providerOrderCoversHold({ id: ORDER, state: "AUTHORISED" }, 750));
});

Deno.test("isSameBookingTrip requires every canonical identifier", () => {
  const trip = {
    id: TRIP_ID,
    payment_session_id: SESSION_ID,
    client_action_id: CAI,
    payment_provider: "revolut",
    provider_order_id: ORDER,
    passenger_id: CUSTOMER_ID,
  };
  assert(isSameBookingTrip(trip, session()));
  assert(!isSameBookingTrip({ ...trip, passenger_id: "other" }, session()));
  assert(!isSameBookingTrip({ ...trip, provider_order_id: "ord-2" }, session()));
  assert(!isSameBookingTrip({ ...trip, client_action_id: "cai-2" }, session()));
  assert(!isSameBookingTrip({ ...trip, payment_session_id: "other" }, session()));
  assert(!isSameBookingTrip({ ...trip, payment_provider: "other" }, session()));
  assert(!isSameBookingTrip({ ...trip, client_action_id: null }, session({ client_action_id: null })));
});

Deno.test("direct finalize: create-preauth wins → ONE rpc, trip id + code returned", async () => {
  const fake = createFakeSupabase({
    tables: { payment_sessions: [session()], trips: [] },
    rpc: (fn, args) => {
      assertEquals(fn, "finalize_paid_booking_session");
      assertEquals(args, { p_payment_session_id: SESSION_ID });
      fake.tables.trips.push({ id: TRIP_ID, trip_code: "MK-1" });
      return { data: TRIP_ID, error: null };
    },
  });
  const res = await directFinalizeAfterProviderAuthorised(fake.client, finalizeArgs());
  assert(res.finalized);
  if (res.finalized) {
    assertEquals(res.tripId, TRIP_ID);
    assertEquals(res.tripCode, "MK-1");
    assertEquals(res.via, "rpc");
  }
  assertEquals(fake.calls.filter((c) => c.kind === "rpc").length, 1);
  assertEquals(fake.calls.filter((c) => c.kind === "update").length, 0);
  const fields = directFinalizeResponseFields(res);
  assertEquals(fields.ride_id, TRIP_ID);
  assertEquals(fields.trip_code, "MK-1");
  assertEquals(fields.trip_finalized, true);
});

Deno.test("direct finalize: webhook already won → existing trip, no rpc", async () => {
  const fake = createFakeSupabase({
    tables: { payment_sessions: [session({ trip_id: TRIP_ID })], trips: [{ id: TRIP_ID, trip_code: "MK-2" }] },
  });
  const res = await directFinalizeAfterProviderAuthorised(fake.client, finalizeArgs());
  assert(res.finalized && res.via === "existing" && res.tripCode === "MK-2");
  assertEquals(fake.calls.filter((c) => c.kind === "rpc").length, 0);
});

Deno.test("direct finalize declines without rpc or writes when any gate fails", async () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["order_not_authorised", { order: { ...authorisedOrder(), state: "PENDING" } }, {}],
    ["order_mismatch", { order: { ...authorisedOrder(), id: "ord-x" } }, {}],
    ["order_client_action_mismatch", { order: { ...authorisedOrder(), metadata: { client_action_id: "cai-x" } } }, {}],
    ["no_user", { userId: null }, {}],
    ["no_client_action_id", { clientActionId: "" }, {}],
    ["session_user_mismatch", {}, { user_id: "someone-else" }],
    ["session_order_mismatch", {}, { provider_order_id: "ord-x" }],
    ["session_not_authorised", {}, { provider_state: "PENDING" }],
    ["provider_amount_below_hold", { order: { ...authorisedOrder(500), amount: 500 } }, {}],
    ["session_not_eligible", {}, { status: "payment_orphaned" }],
    ["session_not_ride_booking", {}, { purpose: "SAVE_CARD" }],
  ];
  for (const [reason, argOver, sessionOver] of cases) {
    const fake = createFakeSupabase({
      tables: { payment_sessions: [session(sessionOver)], trips: [] },
      rpc: () => {
        throw new Error("rpc must not be called");
      },
    });
    const res = await directFinalizeAfterProviderAuthorised(fake.client, finalizeArgs(argOver));
    assert(!res.finalized, reason);
    if (!res.finalized) assertEquals(res.reason, reason);
    assertEquals(fake.calls.filter((c) => c.kind === "rpc" || c.kind === "update").length, 0, reason);
  }
});

Deno.test("direct finalize: RPC failure → finalized:false, no payment mutation (webhook/CTAP fallback)", async () => {
  const fake = createFakeSupabase({
    tables: { payment_sessions: [session()], trips: [] },
    rpc: () => ({ data: null, error: { message: "CUSTOMER_ALREADY_HAS_ACTIVE_TRIP:abc" } }),
  });
  const res = await directFinalizeAfterProviderAuthorised(fake.client, finalizeArgs());
  assert(!res.finalized);
  if (!res.finalized) assert(res.reason.startsWith("rpc_error:"));
  assertEquals(fake.calls.filter((c) => c.kind === "update").length, 0);
  assertEquals(directFinalizeResponseFields(res).ride_id, undefined);
});

Deno.test("direct finalize never throws when the RPC transport throws", async () => {
  const fake = createFakeSupabase({
    tables: { payment_sessions: [session()], trips: [] },
    rpc: () => {
      throw new Error("network");
    },
  });
  const res = await directFinalizeAfterProviderAuthorised(fake.client, finalizeArgs());
  assert(!res.finalized);
});

Deno.test("webhook same-booking guard links and reports; different booking returns null", async () => {
  const trip = {
    id: TRIP_ID,
    payment_session_id: SESSION_ID,
    client_action_id: CAI,
    payment_provider: "revolut",
    provider_order_id: ORDER,
    passenger_id: CUSTOMER_ID,
  };
  const same = createFakeSupabase({ tables: { trips: [trip], payment_sessions: [session()] } });
  assertEquals(await linkSameBookingTripIfMatch(same.client, session(), TRIP_ID, "now"), TRIP_ID);
  assertEquals(same.tables.payment_sessions[0].trip_id, TRIP_ID);

  const other = createFakeSupabase({
    tables: { trips: [{ ...trip, client_action_id: "cai-other", payment_session_id: "s2", provider_order_id: "ord-2" }], payment_sessions: [session()] },
  });
  assertEquals(await linkSameBookingTripIfMatch(other.client, session(), TRIP_ID, "now"), null);
  assertEquals(other.calls.filter((c) => c.kind === "update").length, 0);

  const linkFails = createFakeSupabase({
    tables: { trips: [trip], payment_sessions: [session()] },
    updateError: { payment_sessions: { message: "boom" } },
  });
  // Still the same booking → caller must not orphan/cancel.
  assertEquals(await linkSameBookingTripIfMatch(linkFails.client, session(), TRIP_ID, "now", () => {}), TRIP_ID);
});

Deno.test("source lock: exactly one finalize_paid_booking_session rpc call site in Edge TS", async () => {
  const root = new URL("../../functions/", import.meta.url);
  const hits: string[] = [];
  const walk = async (dir: URL) => {
    for await (const e of Deno.readDir(dir)) {
      const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
      if (e.isDirectory) {
        if (e.name === "node_modules") continue;
        await walk(u);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        const src = await Deno.readTextFile(u);
        if (/\.rpc\(\s*["']finalize_paid_booking_session["']/.test(src)) hits.push(u.pathname.split("/functions/")[1]);
      }
    }
  };
  await walk(root);
  const booking = hits.filter((h) => !h.startsWith("finalize-paid-booking-session/") && !h.startsWith("cancel-payment-session/"));
  assertEquals(booking, ["_shared/bookingDirectFinalizeSSOT.ts"]);
});

Deno.test("source lock: webhook same-booking guard precedes orphan update and cancel is conditional", async () => {
  const src = await Deno.readTextFile(new URL("../../functions/revolut-webhook/index.ts", import.meta.url));
  const guard = src.indexOf("linkSameBookingTripIfMatch(supabase, session");
  const orphan = src.indexOf('status: "payment_orphaned"');
  const cancel = src.indexOf("await cancelRevolutOrder(environment, secretKey, orderId)");
  assert(guard > 0 && orphan > guard && cancel > orphan, "guard → orphan → cancel order");
  assert(src.includes("if (orderId && orphanApplied)"), "cancel gated on orphan row actually written");
  assert(src.includes("classifyAutoFinalizeSession(session)"));
  assert(src.includes("invokeFinalizePaidBookingSession("));
});
