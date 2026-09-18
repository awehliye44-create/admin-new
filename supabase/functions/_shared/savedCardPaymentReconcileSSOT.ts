/**
 * Saved-card Book reconcile SSOT.
 *
 * Revolut may leave the *order* PENDING while a nested *payment* is already
 * FAILED (e.g. decline_reason=technical_error). Webhook/confirm that only read
 * order.state mislabel this as PROCESSING / pending_payment (classification G).
 *
 * This module is the single mapper used by:
 *   - reconcile-payment-session (customer)
 *   - confirm-revolut-payment (poll)
 *   - revolut-webhook (when payment-level failure is visible)
 *   - create-preauth saved_card_pending / failed handoff
 *
 * lifecycle_provider_state MUST be the canonical vocabulary from
 * paymentSessionLifecycleStateSSOT (FAILED not PAYMENT_FAILED; CANCELLED;
 * AUTHORISED; PROCESSING). Consumers feed it into the webhook lifecycle resolver.
 *
 * NO new provider orders. NO card delete on technical_error. NO ledger / trip.
 * Lock: savedCardPaymentReconcileLock.test.ts
 */

import { normalizeLifecycleProviderState } from "./paymentSessionLifecycleStateSSOT.ts";

export const SAVED_CARD_RECONCILE_CLIENT_STATES = [
  "AUTHORISED",
  "CUSTOMER_ACTION_REQUIRED",
  "PAYMENT_PROCESSING",
  "PAYMENT_FAILED",
  "DECLINED",
  "CANCELLED",
] as const;

export type SavedCardReconcileClientState =
  (typeof SAVED_CARD_RECONCILE_CLIENT_STATES)[number];

/** Bounded cooldown after terminal failure before a *fresh* Book is allowed. */
export const SAVED_CARD_TERMINAL_FAILURE_THROTTLE_MS = 30_000;

/** Soft cap on reconcile polls while still PROCESSING (client + edge). */
export const SAVED_CARD_RECONCILE_MIN_INTERVAL_MS = 1_500;

const ORDER_AUTHORISED = new Set(["AUTHORISED", "AUTHORIZED"]);
const ORDER_CANCELLED = new Set(["CANCELLED", "CANCELED"]);
const ORDER_FAILED = new Set(["FAILED"]);
const ORDER_DECLINED = new Set(["DECLINED"]);
const ORDER_IN_FLIGHT = new Set(["PENDING", "PROCESSING"]);

const PAYMENT_AUTHORISED = new Set([
  "AUTHORISED",
  "AUTHORIZED",
  "CAPTURED",
  "COMPLETED",
]);
const PAYMENT_FAILED = new Set(["FAILED", "DECLINED", "CANCELLED", "CANCELED"]);
const PAYMENT_ACS = new Set(["AUTHENTICATION_CHALLENGE"]);

/** Decline reasons that are provider/technical — never invalidate a verified vault card. */
const TECHNICAL_DECLINE_REASONS = new Set([
  "technical_error",
  "TECHNICAL_ERROR",
  "provider_error",
  "system_error",
  "timeout",
  "processing_error",
]);

export type SavedCardPaymentSnapshot = {
  id?: string | null;
  state?: string | null;
  decline_reason?: string | null;
  authentication_challenge?: { acs_url?: string | null } | null;
};

export type SavedCardOrderSnapshot = {
  id?: string | null;
  state?: string | null;
  payments?: SavedCardPaymentSnapshot[] | null;
};

export type SavedCardReconcileMapping = {
  client_state: SavedCardReconcileClientState;
  /**
   * Canonical lifecycle provider state fed into payment_sessions webhook
   * resolver. MUST be FAILED|DECLINED|CANCELLED|AUTHORISED|PROCESSING|…
   * from normalizeLifecycleProviderState — never raw PAYMENT_FAILED.
   */
  lifecycle_provider_state: string;
  order_state: string;
  payment_state: string | null;
  payment_id: string | null;
  decline_reason: string | null;
  acs_url: string | null;
  terminal: boolean;
  /** True when failure is technical / non-card — do not invalidate vault token. */
  preserve_saved_card: boolean;
  failure_reason: string | null;
  reason: string;
};

function upper(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

/** Canonical in-flight lifecycle token (PENDING/PROCESSING → PROCESSING). */
function lifecycleInFlight(orderState: string): string {
  const n = normalizeLifecycleProviderState(orderState || "PENDING");
  return n === "UNKNOWN" ? "PROCESSING" : n;
}

export type CanonicalPaymentPick =
  | { kind: "payment"; payment: SavedCardPaymentSnapshot }
  | { kind: "conflict"; reason: string; authorised: SavedCardPaymentSnapshot; failed: SavedCardPaymentSnapshot };

/**
 * Canonical / latest applicable payment under one order.
 * - Later AUTHORISED wins over earlier FAILED.
 * - Later FAILED after an earlier AUTHORISED → conflict (fail closed).
 * - ACS preferred when no AUTHORISED.
 * - Else latest FAILED/DECLINED/CANCELLED.
 */
export function pickCanonicalPayment(
  payments: SavedCardPaymentSnapshot[] | null | undefined,
): CanonicalPaymentPick | null {
  if (!Array.isArray(payments) || payments.length === 0) return null;

  let lastAuthorised: { idx: number; payment: SavedCardPaymentSnapshot } | null = null;
  let lastAcs: { idx: number; payment: SavedCardPaymentSnapshot } | null = null;
  let lastFailed: { idx: number; payment: SavedCardPaymentSnapshot } | null = null;

  for (let i = 0; i < payments.length; i += 1) {
    const p = payments[i];
    const state = upper(p?.state);
    if (PAYMENT_AUTHORISED.has(state)) lastAuthorised = { idx: i, payment: p };
    else if (PAYMENT_ACS.has(state)) lastAcs = { idx: i, payment: p };
    else if (PAYMENT_FAILED.has(state)) lastFailed = { idx: i, payment: p };
  }

  if (lastAuthorised && lastFailed && lastFailed.idx > lastAuthorised.idx) {
    return {
      kind: "conflict",
      reason: "failed_after_authorised_manual_review",
      authorised: lastAuthorised.payment,
      failed: lastFailed.payment,
    };
  }
  if (lastAuthorised) return { kind: "payment", payment: lastAuthorised.payment };
  if (lastAcs) return { kind: "payment", payment: lastAcs.payment };
  if (lastFailed) return { kind: "payment", payment: lastFailed.payment };
  return { kind: "payment", payment: payments[payments.length - 1]! };
}

export function isTechnicalDeclineReason(
  reason: string | null | undefined,
): boolean {
  const raw = String(reason ?? "").trim();
  if (!raw) return false;
  if (TECHNICAL_DECLINE_REASONS.has(raw) || TECHNICAL_DECLINE_REASONS.has(raw.toUpperCase())) {
    return true;
  }
  return /technical|system_error|provider_error|timeout|processing_error/i.test(raw);
}

/**
 * Map order + nested payments → customer reconcile state.
 * Payment-level FAILED wins over order PENDING (incident G).
 */
export function mapSavedCardProviderOrderToReconcileState(
  order: SavedCardOrderSnapshot | null | undefined,
): SavedCardReconcileMapping {
  const orderState = upper(order?.state);
  const picked = pickCanonicalPayment(order?.payments ?? null);

  // Conflicting evidence (FAILED after AUTHORISED) — fail closed; no new order.
  if (picked?.kind === "conflict") {
    return {
      client_state: "PAYMENT_PROCESSING",
      lifecycle_provider_state: lifecycleInFlight(orderState),
      order_state: orderState || "PENDING",
      payment_state: upper(picked.failed.state) || null,
      payment_id: picked.failed.id ? String(picked.failed.id) : null,
      decline_reason: picked.failed.decline_reason
        ? String(picked.failed.decline_reason).trim()
        : null,
      acs_url: null,
      terminal: false,
      preserve_saved_card: true,
      failure_reason: null,
      reason: `conflict_manual_review:${picked.reason}`,
    };
  }

  const payment = picked?.kind === "payment" ? picked.payment : null;
  const paymentState = payment ? upper(payment.state) : null;
  const declineReason = payment?.decline_reason
    ? String(payment.decline_reason).trim()
    : null;
  const acsUrl = payment?.authentication_challenge?.acs_url?.trim() || null;
  const paymentId = payment?.id ? String(payment.id) : null;
  const preserve = isTechnicalDeclineReason(declineReason);

  // 1) ACS on payment
  if (paymentState && PAYMENT_ACS.has(paymentState)) {
    return {
      client_state: "CUSTOMER_ACTION_REQUIRED",
      lifecycle_provider_state: "AUTHENTICATION_CHALLENGE",
      order_state: orderState || "PENDING",
      payment_state: paymentState,
      payment_id: paymentId,
      decline_reason: declineReason,
      acs_url: acsUrl,
      terminal: false,
      preserve_saved_card: true,
      failure_reason: null,
      reason: "payment_authentication_challenge",
    };
  }

  // 2) Order authorised OR payment authorised (booking hold ready)
  if (ORDER_AUTHORISED.has(orderState) || (paymentState && PAYMENT_AUTHORISED.has(paymentState))) {
    return {
      client_state: "AUTHORISED",
      lifecycle_provider_state: "AUTHORISED",
      order_state: orderState || "PENDING",
      payment_state: paymentState,
      payment_id: paymentId,
      decline_reason: declineReason,
      acs_url: null,
      terminal: false,
      preserve_saved_card: true,
      failure_reason: null,
      reason: ORDER_AUTHORISED.has(orderState)
        ? "order_authorised"
        : "payment_authorised",
    };
  }

  // 3) Payment-level terminal failure — even when order still PENDING
  if (paymentState && PAYMENT_FAILED.has(paymentState)) {
    const isDeclined = paymentState === "DECLINED" ||
      (!preserve && Boolean(declineReason) && !isTechnicalDeclineReason(declineReason));
    const isCancelled = paymentState === "CANCELLED" || paymentState === "CANCELED";
    const clientState: SavedCardReconcileClientState = isCancelled
      ? "CANCELLED"
      : isDeclined && !preserve
      ? "DECLINED"
      : "PAYMENT_FAILED";
    // Canonical: FAILED (not PAYMENT_FAILED) or CANCELLED for lifecycle resolver.
    const lifecycle = isCancelled
      ? "CANCELLED"
      : isDeclined && !preserve
      ? "DECLINED"
      : "FAILED";
    const failureReason = declineReason
      ? `REVOLUT_PAYMENT_${paymentState}:${declineReason}`
      : `REVOLUT_PAYMENT_${paymentState}`;
    return {
      client_state: clientState,
      lifecycle_provider_state: lifecycle,
      order_state: orderState || "PENDING",
      payment_state: paymentState,
      payment_id: paymentId,
      decline_reason: declineReason,
      acs_url: null,
      terminal: true,
      preserve_saved_card: preserve || isTechnicalDeclineReason(declineReason),
      failure_reason: failureReason,
      reason: "payment_terminal_negative_overrides_order",
    };
  }

  // 4) Order-level terminal
  if (ORDER_CANCELLED.has(orderState)) {
    return {
      client_state: "CANCELLED",
      lifecycle_provider_state: "CANCELLED",
      order_state: orderState,
      payment_state: paymentState,
      payment_id: paymentId,
      decline_reason: declineReason,
      acs_url: null,
      terminal: true,
      preserve_saved_card: true,
      failure_reason: `REVOLUT_${orderState}`,
      reason: "order_cancelled",
    };
  }
  if (ORDER_FAILED.has(orderState) || ORDER_DECLINED.has(orderState)) {
    const clientState: SavedCardReconcileClientState =
      ORDER_DECLINED.has(orderState) && !preserve ? "DECLINED" : "PAYMENT_FAILED";
    return {
      client_state: clientState,
      lifecycle_provider_state: ORDER_DECLINED.has(orderState) && !preserve
        ? "DECLINED"
        : "FAILED",
      order_state: orderState,
      payment_state: paymentState,
      payment_id: paymentId,
      decline_reason: declineReason,
      acs_url: null,
      terminal: true,
      preserve_saved_card: preserve,
      failure_reason: declineReason
        ? `REVOLUT_${orderState}:${declineReason}`
        : `REVOLUT_${orderState}`,
      reason: "order_terminal_negative",
    };
  }

  // 5) Still in flight (no terminal payment)
  if (ORDER_IN_FLIGHT.has(orderState) || !orderState) {
    return {
      client_state: "PAYMENT_PROCESSING",
      lifecycle_provider_state: lifecycleInFlight(orderState),
      order_state: orderState || "PENDING",
      payment_state: paymentState,
      payment_id: paymentId,
      decline_reason: null,
      acs_url: acsUrl,
      terminal: false,
      preserve_saved_card: true,
      failure_reason: null,
      reason: "order_in_flight",
    };
  }

  // Unknown order state — treat as processing (fail-closed against new orders)
  return {
    client_state: "PAYMENT_PROCESSING",
    lifecycle_provider_state: lifecycleInFlight(orderState),
    order_state: orderState || "UNKNOWN",
    payment_state: paymentState,
    payment_id: paymentId,
    decline_reason: declineReason,
    acs_url: acsUrl,
    terminal: false,
    preserve_saved_card: true,
    failure_reason: null,
    reason: `unknown_order_state:${orderState || "empty"}`,
  };
}

/**
 * Safe opaque reconcile token — no provider secrets.
 * Client echoes it back; server re-derives from session ids.
 */
export function buildSavedCardReconcileToken(args: {
  paymentSessionId: string;
  clientActionId: string;
  providerOrderId: string;
}): string {
  const raw = [
    String(args.paymentSessionId).trim(),
    String(args.clientActionId).trim(),
    String(args.providerOrderId).trim(),
  ].join("|");
  // Lightweight non-crypto fingerprint (Edge-safe). Not a secret — ownership
  // is still enforced via JWT user_id match on the session row.
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `scr_${hex}_${String(args.paymentSessionId).replace(/-/g, "").slice(0, 12)}`;
}

export function verifySavedCardReconcileToken(
  token: string | null | undefined,
  args: {
    paymentSessionId: string;
    clientActionId: string;
    providerOrderId: string;
  },
): boolean {
  const expected = buildSavedCardReconcileToken(args);
  return Boolean(token) && String(token) === expected;
}

export function computeTerminalFailureRetryAfterMs(args: {
  failedAtIso: string | null | undefined;
  nowMs?: number;
  throttleMs?: number;
}): number {
  const throttle = args.throttleMs ?? SAVED_CARD_TERMINAL_FAILURE_THROTTLE_MS;
  const failedAt = args.failedAtIso ? Date.parse(String(args.failedAtIso)) : NaN;
  if (!Number.isFinite(failedAt)) return throttle;
  const elapsed = (args.nowMs ?? Date.now()) - failedAt;
  if (elapsed >= throttle) return 0;
  return Math.max(0, throttle - elapsed);
}

/** Customer-safe handoff fields for saved_card_pending / reconcile responses. */
export function buildSavedCardPendingHandoff(args: {
  paymentSessionId: string;
  clientActionId: string;
  providerOrderId: string;
  providerPaymentId?: string | null;
  clientState?: SavedCardReconcileClientState;
  declineReason?: string | null;
}): Record<string, unknown> {
  const reconcileToken = buildSavedCardReconcileToken({
    paymentSessionId: args.paymentSessionId,
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId,
  });
  return {
    code: "saved_card_pending",
    saved_card_pending: true,
    charge_state: "no_charge",
    payment_session_id: args.paymentSessionId,
    client_action_id: args.clientActionId,
    booking_attempt_id: args.clientActionId,
    provider_order_id: args.providerOrderId,
    payment_intent_id: args.providerOrderId,
    provider_payment_id: args.providerPaymentId ?? null,
    reconcile_token: reconcileToken,
    client_state: args.clientState ?? "PAYMENT_PROCESSING",
    decline_reason: args.declineReason ?? null,
  };
}
