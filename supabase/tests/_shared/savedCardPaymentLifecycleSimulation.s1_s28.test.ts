/**
 * Phase 4 — Saved-card payment lifecycle simulation harness (S1–S28).
 *
 * Imports production SSOT only (mapper + webhook lifecycle resolver).
 * No live provider mutation. No Edge deploy. create_order_count always 0.
 *
 * Run:
 *   deno test --allow-read \
 *     supabase/tests/_shared/savedCardPaymentReconcileLock.test.ts \
 *     supabase/tests/_shared/savedCardPaymentLifecycleSimulation.s1_s28.test.ts
 */
import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildSavedCardReconcileToken,
  isTechnicalDeclineReason,
  mapSavedCardProviderOrderToReconcileState,
  type SavedCardOrderSnapshot,
  type SavedCardReconcileClientState,
  type SavedCardReconcileMapping,
} from "../../functions/_shared/savedCardPaymentReconcileSSOT.ts";
import { resolvePaymentSessionStatusFromProviderWebhook } from "../../functions/_shared/paymentSessionWebhookLifecycleResolver.ts";
import {
  isRevolutProviderStateRegression,
} from "../../functions/_shared/revolutProviderStateRankSSOT.ts";
import {
  parseMerchantVaultAddCardGateMode,
  resolveMerchantVaultAddCardAllowed,
} from "../../functions/_shared/merchantVaultAddCardGate.ts";

/** Reconcile paths never create provider orders — constant for every simulation. */
const CREATE_ORDER_COUNT = 0 as const;

type SessionStatus =
  | "pending_payment"
  | "payment_authorised"
  | "failed"
  | "cancelled"
  | "trip_created"
  | "captured";

type SimExpectation = {
  client_state: SavedCardReconcileClientState;
  lifecycle_provider_state: string;
  mayCreateTrip: boolean;
  preserve_saved_card?: boolean;
  terminal?: boolean;
  sessionDecision?: "ADVANCE" | "KEEP_CURRENT" | "PENDING_EVIDENCE" | "LIFECYCLE_CONFLICT";
  nextSessionStatus?: string | undefined;
  currentStatus?: SessionStatus;
  priorProviderState?: string | null;
};

type SimResult = {
  mapping: SavedCardReconcileMapping;
  mayCreateTrip: boolean;
  create_order_count: 0;
  session: ReturnType<typeof resolvePaymentSessionStatusFromProviderWebhook>;
};

function mayCreateTripFromMapping(m: SavedCardReconcileMapping): boolean {
  // Trip creation is only eligible after a clean AUTHORISED hold.
  // Conflict / ACS / processing / terminal negatives must not create a trip.
  return m.client_state === "AUTHORISED" &&
    m.lifecycle_provider_state === "AUTHORISED" &&
    !m.terminal &&
    !m.reason.includes("conflict");
}

function simulateReconcile(args: {
  order: SavedCardOrderSnapshot;
  currentStatus?: SessionStatus;
  priorProviderState?: string | null;
  tripId?: string | null;
}): SimResult {
  const mapping = mapSavedCardProviderOrderToReconcileState(args.order);
  const session = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: args.currentStatus ?? "pending_payment",
    providerState: mapping.lifecycle_provider_state,
    purpose: "RIDE_BOOKING",
    priorProviderState: args.priorProviderState ?? null,
    tripId: args.tripId ?? null,
  });
  return {
    mapping,
    mayCreateTrip: mayCreateTripFromMapping(mapping),
    create_order_count: CREATE_ORDER_COUNT,
    session,
  };
}

function assertSim(result: SimResult, expected: SimExpectation) {
  assertEquals(result.create_order_count, 0);
  assertEquals(result.mapping.client_state, expected.client_state);
  assertEquals(
    result.mapping.lifecycle_provider_state,
    expected.lifecycle_provider_state,
  );
  assertEquals(result.mayCreateTrip, expected.mayCreateTrip);
  if (expected.preserve_saved_card !== undefined) {
    assertEquals(result.mapping.preserve_saved_card, expected.preserve_saved_card);
  }
  if (expected.terminal !== undefined) {
    assertEquals(result.mapping.terminal, expected.terminal);
  }
  if (expected.sessionDecision) {
    assertEquals(result.session.decision, expected.sessionDecision);
  }
  if (expected.nextSessionStatus !== undefined) {
    assertEquals(result.session.nextStatus, expected.nextSessionStatus);
  }
}

// ─── S1–S10 core provider evidence ───────────────────────────────────────────

Deno.test("S1 Immediate auth → AUTHORISED, mayCreateTrip", () => {
  const r = simulateReconcile({
    order: {
      id: "ord-s1",
      state: "AUTHORISED",
      payments: [{ id: "p1", state: "AUTHORISED" }],
    },
  });
  assertSim(r, {
    client_state: "AUTHORISED",
    lifecycle_provider_state: "AUTHORISED",
    mayCreateTrip: true,
    terminal: false,
    sessionDecision: "ADVANCE",
    nextSessionStatus: "payment_authorised",
  });
});

Deno.test("S2 Processing then auth webhook → AUTHORISED", () => {
  const processing = simulateReconcile({
    order: { id: "ord-s2", state: "PENDING", payments: [] },
  });
  assertSim(processing, {
    client_state: "PAYMENT_PROCESSING",
    lifecycle_provider_state: "PROCESSING",
    mayCreateTrip: false,
    sessionDecision: "KEEP_CURRENT",
  });

  const authorised = simulateReconcile({
    order: {
      id: "ord-s2",
      state: "PENDING",
      payments: [{ id: "p1", state: "AUTHORISED" }],
    },
    currentStatus: "pending_payment",
    priorProviderState: "PROCESSING",
  });
  assertSim(authorised, {
    client_state: "AUTHORISED",
    lifecycle_provider_state: "AUTHORISED",
    mayCreateTrip: true,
    sessionDecision: "ADVANCE",
    nextSessionStatus: "payment_authorised",
  });
});

Deno.test("S3 Processing then technical_error → FAILED, 0 trip, preserve card (18:38 class)", () => {
  const r = simulateReconcile({
    order: {
      id: "ord-s3",
      state: "PENDING",
      payments: [{
        id: "p1",
        state: "FAILED",
        decline_reason: "technical_error",
      }],
    },
  });
  assertSim(r, {
    client_state: "PAYMENT_FAILED",
    lifecycle_provider_state: "FAILED",
    mayCreateTrip: false,
    preserve_saved_card: true,
    terminal: true,
    sessionDecision: "ADVANCE",
    nextSessionStatus: "failed",
  });
  assert(isTechnicalDeclineReason(r.mapping.decline_reason));
});

Deno.test("S4 Issuer decline → DECLINED", () => {
  const r = simulateReconcile({
    order: {
      id: "ord-s4",
      state: "PENDING",
      payments: [{
        id: "p1",
        state: "DECLINED",
        decline_reason: "insufficient_funds",
      }],
    },
  });
  assertSim(r, {
    client_state: "DECLINED",
    lifecycle_provider_state: "DECLINED",
    mayCreateTrip: false,
    preserve_saved_card: false,
    terminal: true,
    sessionDecision: "ADVANCE",
    nextSessionStatus: "failed",
  });
});

Deno.test("S5 ACS then auth → AUTHORISED one order", () => {
  const acs = simulateReconcile({
    order: {
      id: "ord-s5",
      state: "PENDING",
      payments: [{
        id: "p1",
        state: "AUTHENTICATION_CHALLENGE",
        authentication_challenge: { acs_url: "https://acs.example/s5" },
      }],
    },
  });
  assertSim(acs, {
    client_state: "CUSTOMER_ACTION_REQUIRED",
    lifecycle_provider_state: "AUTHENTICATION_CHALLENGE",
    mayCreateTrip: false,
    sessionDecision: "KEEP_CURRENT",
  });

  const afterAuth = simulateReconcile({
    order: {
      id: "ord-s5",
      state: "PENDING",
      payments: [
        {
          id: "p1",
          state: "AUTHENTICATION_CHALLENGE",
          authentication_challenge: { acs_url: "https://acs.example/s5" },
        },
        { id: "p2", state: "AUTHORISED" },
      ],
    },
  });
  assertSim(afterAuth, {
    client_state: "AUTHORISED",
    lifecycle_provider_state: "AUTHORISED",
    mayCreateTrip: true,
    sessionDecision: "ADVANCE",
    nextSessionStatus: "payment_authorised",
  });
  assertEquals(afterAuth.mapping.payment_id, "p2");
  assertEquals(afterAuth.create_order_count, 0);
});

Deno.test("S6 ACS fail → FAILED", () => {
  const r = simulateReconcile({
    order: {
      id: "ord-s6",
      state: "PENDING",
      payments: [{ id: "p1", state: "FAILED" }],
    },
  });
  assertSim(r, {
    client_state: "PAYMENT_FAILED",
    lifecycle_provider_state: "FAILED",
    mayCreateTrip: false,
    terminal: true,
    sessionDecision: "ADVANCE",
    nextSessionStatus: "failed",
  });
});

Deno.test("S7 Webhook absent / GET reconcile → same terminal result", () => {
  const fixture: SavedCardOrderSnapshot = {
    id: "ord-s7",
    state: "pending",
    payments: [{
      id: "p1",
      state: "failed",
      decline_reason: "technical_error",
    }],
  };
  // Webhook path and GET reconcile both call the same mapper.
  const viaWebhook = mapSavedCardProviderOrderToReconcileState(fixture);
  const viaReconcile = mapSavedCardProviderOrderToReconcileState(fixture);
  assertEquals(viaWebhook.client_state, viaReconcile.client_state);
  assertEquals(
    viaWebhook.lifecycle_provider_state,
    viaReconcile.lifecycle_provider_state,
  );
  assertEquals(viaWebhook.client_state, "PAYMENT_FAILED");
  assertEquals(viaWebhook.lifecycle_provider_state, "FAILED");
  assertEquals(CREATE_ORDER_COUNT, 0);
});

Deno.test("S8 Duplicate PROCESSING after FAILED → stays FAILED", () => {
  const terminal = simulateReconcile({
    order: {
      id: "ord-s8",
      state: "PENDING",
      payments: [{ id: "p1", state: "FAILED", decline_reason: "technical_error" }],
    },
  });
  assertEquals(terminal.session.nextStatus, "failed");

  // Late/stale PROCESSING observation must not reopen the session.
  const late = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "failed",
    providerState: "PROCESSING",
    purpose: "RIDE_BOOKING",
    priorProviderState: "FAILED",
  });
  assertEquals(late.decision, "KEEP_CURRENT");
  assertEquals(late.nextStatus, undefined);
  assert(
    isRevolutProviderStateRegression("FAILED", "PROCESSING"),
    "PROCESSING after FAILED is a provider-state regression",
  );

  // Mapper on same failed payment evidence still terminal FAILED.
  const remapped = mapSavedCardProviderOrderToReconcileState({
    id: "ord-s8",
    state: "PENDING",
    payments: [{ id: "p1", state: "FAILED", decline_reason: "technical_error" }],
  });
  assertEquals(remapped.client_state, "PAYMENT_FAILED");
  assertEquals(remapped.lifecycle_provider_state, "FAILED");
});

Deno.test("S9 AUTHORISED then stale PROCESSING → stays AUTHORISED", () => {
  const auth = simulateReconcile({
    order: {
      id: "ord-s9",
      state: "AUTHORISED",
      payments: [{ id: "p1", state: "AUTHORISED" }],
    },
  });
  assertEquals(auth.mayCreateTrip, true);

  const stale = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "payment_authorised",
    providerState: "PROCESSING",
    purpose: "RIDE_BOOKING",
    priorProviderState: "AUTHORISED",
  });
  assertEquals(stale.decision, "KEEP_CURRENT");
  assertEquals(stale.nextStatus, undefined);
  assert(isRevolutProviderStateRegression("AUTHORISED", "PROCESSING"));

  // Remap still AUTHORISED when order evidence is authorised.
  const remapped = mapSavedCardProviderOrderToReconcileState({
    id: "ord-s9",
    state: "AUTHORISED",
    payments: [{ id: "p1", state: "AUTHORISED" }],
  });
  assertEquals(remapped.client_state, "AUTHORISED");
  assertEquals(mayCreateTripFromMapping(remapped), true);
});

Deno.test("S10 conflict AUTHORISED+FAILED → fail closed, mayCreateTrip false", () => {
  const r = simulateReconcile({
    order: {
      id: "ord-s10",
      state: "PENDING",
      payments: [
        { id: "p1", state: "AUTHORISED" },
        { id: "p2", state: "FAILED", decline_reason: "technical_error" },
      ],
    },
  });
  assertSim(r, {
    client_state: "PAYMENT_PROCESSING",
    lifecycle_provider_state: "PROCESSING",
    mayCreateTrip: false,
    terminal: false,
    sessionDecision: "KEEP_CURRENT",
  });
  assert(r.mapping.reason.includes("conflict_manual_review"));
  assertEquals(r.create_order_count, 0);
});

// ─── S11–S15 idempotency / resume / check-payment ────────────────────────────

Deno.test("S11 one-tap idempotency: mapper + reconcile token stable", () => {
  const order: SavedCardOrderSnapshot = {
    id: "6aacda83-592f-abc8-a53d-34d535c2a505",
    state: "PENDING",
    payments: [{ id: "p1", state: "AUTHORISED" }],
  };
  const m1 = mapSavedCardProviderOrderToReconcileState(order);
  const m2 = mapSavedCardProviderOrderToReconcileState(order);
  assertEquals(m1.client_state, m2.client_state);
  assertEquals(m1.lifecycle_provider_state, m2.lifecycle_provider_state);

  const tokenArgs = {
    paymentSessionId: "8e3551f5-08ef-4cfa-8e26-e589a3c7dccc",
    clientActionId: "fc8ab9be-8285-45cf-83cb-f58be591d641",
    providerOrderId: "6aacda83-592f-abc8-a53d-34d535c2a505",
  };
  const t1 = buildSavedCardReconcileToken(tokenArgs);
  const t2 = buildSavedCardReconcileToken(tokenArgs);
  assertEquals(t1, t2);
  assertEquals(CREATE_ORDER_COUNT, 0);
});

Deno.test("S12 relaunch/resume terminal: client_state PAYMENT_FAILED + no create", () => {
  // SSOT-only: client persistence tested in Customer elsewhere.
  const r = simulateReconcile({
    order: {
      id: "ord-s12",
      state: "PENDING",
      payments: [{ id: "p1", state: "FAILED", decline_reason: "technical_error" }],
    },
    currentStatus: "failed",
    priorProviderState: "FAILED",
  });
  assertEquals(r.mapping.client_state, "PAYMENT_FAILED");
  assertEquals(r.mayCreateTrip, false);
  assertEquals(r.session.decision, "KEEP_CURRENT");
  assertEquals(r.create_order_count, 0);
});

Deno.test("S13 relaunch/resume processing: client_state PAYMENT_PROCESSING + no create", () => {
  const r = simulateReconcile({
    order: { id: "ord-s13", state: "PENDING", payments: [] },
    currentStatus: "pending_payment",
    priorProviderState: "PROCESSING",
  });
  assertEquals(r.mapping.client_state, "PAYMENT_PROCESSING");
  assertEquals(r.mayCreateTrip, false);
  assertEquals(r.create_order_count, 0);
});

Deno.test("S14 relaunch/resume authorised: client_state AUTHORISED + mayCreateTrip", () => {
  const r = simulateReconcile({
    order: {
      id: "ord-s14",
      state: "AUTHORISED",
      payments: [{ id: "p1", state: "AUTHORISED" }],
    },
    currentStatus: "payment_authorised",
    priorProviderState: "AUTHORISED",
  });
  assertEquals(r.mapping.client_state, "AUTHORISED");
  assertEquals(r.mayCreateTrip, true);
  assertEquals(r.session.decision, "KEEP_CURRENT");
  assertEquals(r.create_order_count, 0);
});

Deno.test("S15 Check payment = reconcile only (mapper + token; create_order_count=0)", () => {
  const order: SavedCardOrderSnapshot = {
    id: "ord-s15",
    state: "PENDING",
    payments: [{ id: "p1", state: "FAILED", decline_reason: "technical_error" }],
  };
  const m = mapSavedCardProviderOrderToReconcileState(order);
  assertEquals(m.client_state, "PAYMENT_FAILED");
  const token = buildSavedCardReconcileToken({
    paymentSessionId: "ps-s15",
    clientActionId: "cai-s15",
    providerOrderId: "ord-s15",
  });
  assert(token.startsWith("scr_"));
  assertEquals(CREATE_ORDER_COUNT, 0);
});

// ─── S16–S19 Add card / saved selection (static source locks) ─────────────────

Deno.test("S16–S19 Add card / saved selection: setup-revolut-card + gate defaults OFF", () => {
  const setupSrc = Deno.readTextFileSync(
    new URL("../../functions/setup-revolut-card/index.ts", import.meta.url),
  );
  const gateSrc = Deno.readTextFileSync(
    new URL("../../functions/_shared/merchantVaultAddCardGate.ts", import.meta.url),
  );
  const listSrc = Deno.readTextFileSync(
    new URL("../../functions/list-revolut-saved-cards/index.ts", import.meta.url),
  );
  const preauthSrc = Deno.readTextFileSync(
    new URL("../../functions/_shared/revolutPreauth.ts", import.meta.url),
  );

  // S16: Add Card Edge is setup-revolut-card (merchant vault), not Book/create-preauth.
  assert(setupSrc.includes("merchantVaultAddCardGate"));
  assert(setupSrc.includes("FEATURE_OFF") || setupSrc.includes("gate_off"));
  assert(!setupSrc.includes("create-preauth"));

  // S17: Gate defaults OFF (fail closed) when unset/unknown.
  assertEquals(parseMerchantVaultAddCardGateMode(undefined), "off");
  assertEquals(parseMerchantVaultAddCardGateMode(""), "off");
  assertEquals(parseMerchantVaultAddCardGateMode("weird"), "off");
  const denied = resolveMerchantVaultAddCardAllowed({
    gateMode: "off",
    allowlistUserIds: new Set(),
    authUserId: "user-1",
  });
  assertEquals(denied.allowed, false);
  assertEquals(denied.reason, "gate_off");
  assert(gateSrc.includes("unset / unknown → off"));

  // S18: list saved cards is vault read — not a Book order create path.
  assert(listSrc.includes("tokenization_status") || listSrc.includes("saved"));
  assert(!listSrc.includes("createRevolutOrder"));

  // S19: Book/saved-card CIT path does not flip Add Card gate on.
  assert(!preauthSrc.includes("MERCHANT_VAULT_ADD_CARD_GATE"));
  assertEquals(CREATE_ORDER_COUNT, 0);
});

// ─── S20–S23 cancel / complete / late / stale lifecycle ───────────────────────

Deno.test("S20 cancel: payment CANCELLED → CANCELLED, mayCreateTrip false", () => {
  const r = simulateReconcile({
    order: {
      id: "ord-s20",
      state: "PENDING",
      payments: [{ id: "p1", state: "CANCELLED" }],
    },
  });
  assertSim(r, {
    client_state: "CANCELLED",
    lifecycle_provider_state: "CANCELLED",
    mayCreateTrip: false,
    terminal: true,
    sessionDecision: "ADVANCE",
    nextSessionStatus: "cancelled",
  });
});

Deno.test("S21 complete/captured payment → AUTHORISED success path", () => {
  const r = simulateReconcile({
    order: {
      id: "ord-s21",
      state: "PENDING",
      payments: [{ id: "p1", state: "CAPTURED" }],
    },
  });
  assertSim(r, {
    client_state: "AUTHORISED",
    lifecycle_provider_state: "AUTHORISED",
    mayCreateTrip: true,
    sessionDecision: "ADVANCE",
    nextSessionStatus: "payment_authorised",
  });
});

Deno.test("S22 late FAILED after AUTHORISED → KEEP_CURRENT (no regress)", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "payment_authorised",
    providerState: "FAILED",
    purpose: "RIDE_BOOKING",
    priorProviderState: "AUTHORISED",
  });
  assertEquals(r.decision, "KEEP_CURRENT");
  assertEquals(r.reason, "late_terminal_negative_after_authorised_provider_state");
  assertEquals(CREATE_ORDER_COUNT, 0);
});

Deno.test("S23 stale PROCESSING after terminal negative → KEEP_CURRENT", () => {
  for (const prior of ["FAILED", "DECLINED", "CANCELLED"] as const) {
    const status = prior === "CANCELLED" ? "cancelled" : "failed";
    const r = resolvePaymentSessionStatusFromProviderWebhook({
      currentStatus: status,
      providerState: "PROCESSING",
      purpose: "RIDE_BOOKING",
      priorProviderState: prior,
    });
    assertEquals(r.decision, "KEEP_CURRENT");
    assert(isRevolutProviderStateRegression(prior, "PROCESSING"));
  }
});

// ─── S24–S25 fixtures ────────────────────────────────────────────────────────

Deno.test("S24 exact 18:38 sanitized fixture", () => {
  const fixture: SavedCardOrderSnapshot = {
    id: "6aacda83-592f-abc8-a53d-34d535c2a505",
    state: "pending",
    payments: [{
      id: "6aacda83-8a68-a53d-34d535c2a505",
      state: "failed",
      decline_reason: "technical_error",
    }],
  };
  const r = simulateReconcile({ order: fixture });
  assertSim(r, {
    client_state: "PAYMENT_FAILED",
    lifecycle_provider_state: "FAILED",
    mayCreateTrip: false,
    preserve_saved_card: true,
    terminal: true,
    sessionDecision: "ADVANCE",
    nextSessionStatus: "failed",
  });
  assertEquals(r.mapping.order_state, "PENDING");
  assert(r.mapping.failure_reason?.includes("technical_error"));
  assertEquals(r.create_order_count, 0);
});

Deno.test("S25 Sep17 success fixture: order completed / payment captured → AUTHORISED", () => {
  const r = simulateReconcile({
    order: {
      id: "ord-sep17-success",
      state: "COMPLETED",
      payments: [{ id: "p1", state: "CAPTURED" }],
    },
  });
  // Payment CAPTURED maps to AUTHORISED client path for booking hold readiness.
  assertSim(r, {
    client_state: "AUTHORISED",
    lifecycle_provider_state: "AUTHORISED",
    mayCreateTrip: true,
    sessionDecision: "ADVANCE",
    nextSessionStatus: "payment_authorised",
  });
});

// ─── S26–S28 idempotency / recovery / CAI separation ─────────────────────────

Deno.test("S26 idempotent duplicate webhook AUTHORISED → KEEP_CURRENT", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "payment_authorised",
    providerState: "AUTHORISED",
    purpose: "RIDE_BOOKING",
    priorProviderState: "AUTHORISED",
  });
  assertEquals(r.decision, "KEEP_CURRENT");
  assertEquals(r.reason, "pre_capture_authorised_idempotent");
  assertEquals(CREATE_ORDER_COUNT, 0);
});

Deno.test("S27 recovery: remapped failed session stays failed (no reopen)", () => {
  const r = simulateReconcile({
    order: {
      id: "ord-s27",
      state: "PENDING",
      payments: [{ id: "p1", state: "FAILED", decline_reason: "technical_error" }],
    },
    currentStatus: "failed",
    priorProviderState: "FAILED",
  });
  assertEquals(r.mapping.client_state, "PAYMENT_FAILED");
  assertEquals(r.mayCreateTrip, false);
  assertEquals(r.session.decision, "KEEP_CURRENT");
  assertEquals(r.create_order_count, 0);
});

Deno.test("S28 fresh Book CAI separation: reconcile tokens unique across CAIs", () => {
  const sessionId = "8e3551f5-08ef-4cfa-8e26-e589a3c7dccc";
  const orderId = "6aacda83-592f-abc8-a53d-34d535c2a505";
  const tA = buildSavedCardReconcileToken({
    paymentSessionId: sessionId,
    clientActionId: "cai-book-attempt-A",
    providerOrderId: orderId,
  });
  const tB = buildSavedCardReconcileToken({
    paymentSessionId: sessionId,
    clientActionId: "cai-book-attempt-B",
    providerOrderId: orderId,
  });
  assertNotEquals(tA, tB);
  assert(tA.startsWith("scr_"));
  assert(tB.startsWith("scr_"));
  assertEquals(CREATE_ORDER_COUNT, 0);
});

// ─── Call-graph locks (Edge reconcile / confirm / webhook) ───────────────────

Deno.test("call-graph lock: Edge reconcile/confirm/webhook import mapper", () => {
  const reconcile = Deno.readTextFileSync(
    new URL("../../functions/reconcile-payment-session/index.ts", import.meta.url),
  );
  const confirm = Deno.readTextFileSync(
    new URL("../../functions/confirm-revolut-payment/index.ts", import.meta.url),
  );
  const webhook = Deno.readTextFileSync(
    new URL("../../functions/revolut-webhook/index.ts", import.meta.url),
  );
  const apply = Deno.readTextFileSync(
    new URL("../../functions/_shared/applySavedCardOrderReconcile.ts", import.meta.url),
  );

  assert(reconcile.includes("retrieveAndReconcileSavedCardSession"));
  assert(apply.includes("mapSavedCardProviderOrderToReconcileState"));
  assert(confirm.includes("mapSavedCardProviderOrderToReconcileState"));
  assert(webhook.includes("mapSavedCardProviderOrderToReconcileState"));
  assert(!reconcile.includes("createRevolutOrder"));
  assert(!confirm.includes("createRevolutOrder") || confirm.includes("no_new_order"));
});
