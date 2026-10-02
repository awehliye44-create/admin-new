/**
 * Revolut incremental-authorisation provider evidence (pure helpers).
 *
 * Documented contract (Merchant API 2026-04-20):
 *   incremental_authorisations[].state   pending | processing | authorised | declined | failed
 *   incremental_authorisations[].reason  present only when state is declined or failed
 *   declined = declined by the card issuer / card network
 *   failed   = technical error, NOT an issuer decline
 *
 * Evidence is an allow-list of scalar fields. Card details, payment method
 * objects, tokens, checkout URLs and customer data are never copied.
 */

import type { RevolutOrder } from "./revolutOrders.ts";

export type ProviderIncrementState =
  | "pending"
  | "processing"
  | "authorised"
  | "declined"
  | "failed";

export type IncrementAttemptMatch = "reference" | "target_amount" | "latest" | null;

export type RevolutIncrementProviderEvidence = {
  evidence_source: "post_response" | "retrieve" | "webhook_retrieve";
  captured_at: string;
  increment_state: ProviderIncrementState | string | null;
  increment_reason: string | null;
  increment_reason_field: "reason" | "decline_reason" | null;
  increment_old_amount_pence: number | null;
  increment_new_amount_pence: number | null;
  increment_reference: string | null;
  increment_matched_by: IncrementAttemptMatch;
  increment_attempt_count: number;
  requested_target_total_pence: number | null;
  previous_authorised_total_pence: number | null;
  payment_state: string | null;
  payment_amount_pence: number | null;
  payment_authorised_amount_pence: number | null;
  payment_decline_reason: string | null;
  order_state: string | null;
  provider_authorised_total_pence: number | null;
  post_http_status: number | null;
  post_http_ok: boolean | null;
};

type IncrementEntry = NonNullable<RevolutOrder["incremental_authorisations"]>[number];

const MAX_REASON_LENGTH = 200;
const MAX_REFERENCE_LENGTH = 100;

function minorOrNull(value: unknown): number | null {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 && value !== null && value !== "" ? n : null;
}

/** Provider codes are short tokens; never persist free-form blobs. */
export function sanitizeProviderToken(value: unknown, maxLength = MAX_REASON_LENGTH): string | null {
  if (value == null) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const s = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!s) return null;
  return s.slice(0, maxLength);
}

export function normalizeProviderIncrementState(value: unknown): ProviderIncrementState | string | null {
  const s = String(value ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "authorized") return "authorised";
  return s;
}

/**
 * Reason for a declined/failed increment. Reads the documented `reason` field;
 * `decline_reason` is accepted only as a backward-compatible fallback.
 */
export function readIncrementProviderReason(
  increment: unknown,
): { reason: string | null; field: "reason" | "decline_reason" | null } {
  if (!increment || typeof increment !== "object") return { reason: null, field: null };
  const rec = increment as Record<string, unknown>;
  const documented = sanitizeProviderToken(rec.reason);
  if (documented) return { reason: documented, field: "reason" };
  const legacy = sanitizeProviderToken(rec.decline_reason);
  if (legacy) return { reason: legacy, field: "decline_reason" };
  return { reason: null, field: null };
}

/**
 * The increment attempt that belongs to THIS request: match our reference,
 * then the requested target total (latest first), then the latest entry.
 */
export function findIncrementAttempt(
  order: RevolutOrder | null | undefined,
  args: { reference?: string | null; targetTotalPence?: number | null },
): { entry: IncrementEntry | null; matchedBy: IncrementAttemptMatch; count: number } {
  const list = Array.isArray(order?.incremental_authorisations)
    ? order!.incremental_authorisations!
    : [];
  if (list.length === 0) return { entry: null, matchedBy: null, count: 0 };

  const reference = sanitizeProviderToken(args.reference, MAX_REFERENCE_LENGTH);
  if (reference) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (sanitizeProviderToken(list[i]?.reference, MAX_REFERENCE_LENGTH) === reference) {
        return { entry: list[i], matchedBy: "reference", count: list.length };
      }
    }
  }

  const target = minorOrNull(args.targetTotalPence);
  if (target != null && target > 0) {
    for (let i = list.length - 1; i >= 0; i--) {
      const amount = minorOrNull(list[i]?.new_amount ?? list[i]?.amount);
      if (amount === target) {
        return { entry: list[i], matchedBy: "target_amount", count: list.length };
      }
    }
  }

  return { entry: list[list.length - 1], matchedBy: "latest", count: list.length };
}

export function buildRevolutIncrementProviderEvidence(args: {
  order: RevolutOrder | null | undefined;
  evidenceSource: RevolutIncrementProviderEvidence["evidence_source"];
  reference?: string | null;
  targetTotalPence?: number | null;
  previousAuthorisedTotalPence?: number | null;
  providerAuthorisedTotalPence?: number | null;
  postHttpStatus?: number | null;
  postHttpOk?: boolean | null;
  nowIso?: string;
}): RevolutIncrementProviderEvidence {
  const attempt = findIncrementAttempt(args.order, {
    reference: args.reference,
    targetTotalPence: args.targetTotalPence,
  });
  const reason = readIncrementProviderReason(attempt.entry);
  const payments = Array.isArray(args.order?.payments) ? args.order!.payments! : [];
  const payment = payments.length > 0 ? payments[payments.length - 1] : null;

  return {
    evidence_source: args.evidenceSource,
    captured_at: args.nowIso ?? new Date().toISOString(),
    increment_state: attempt.entry ? normalizeProviderIncrementState(attempt.entry.state) : null,
    increment_reason: reason.reason,
    increment_reason_field: reason.field,
    increment_old_amount_pence: attempt.entry ? minorOrNull(attempt.entry.old_amount) : null,
    increment_new_amount_pence: attempt.entry
      ? minorOrNull(attempt.entry.new_amount ?? attempt.entry.amount)
      : null,
    increment_reference: attempt.entry
      ? sanitizeProviderToken(attempt.entry.reference, MAX_REFERENCE_LENGTH)
      : null,
    increment_matched_by: attempt.matchedBy,
    increment_attempt_count: attempt.count,
    requested_target_total_pence: minorOrNull(args.targetTotalPence),
    previous_authorised_total_pence: minorOrNull(args.previousAuthorisedTotalPence),
    payment_state: payment ? sanitizeProviderToken(payment.state, 40) : null,
    payment_amount_pence: payment ? minorOrNull(payment.amount) : null,
    payment_authorised_amount_pence: payment ? minorOrNull(payment.authorised_amount) : null,
    payment_decline_reason: payment ? sanitizeProviderToken(payment.decline_reason) : null,
    order_state: args.order ? sanitizeProviderToken(args.order.state, 40) : null,
    provider_authorised_total_pence: minorOrNull(args.providerAuthorisedTotalPence),
    post_http_status: args.postHttpStatus ?? null,
    post_http_ok: args.postHttpOk ?? null,
  };
}

/**
 * Provider outcome of the attempt, independent of ONECAB coverage math.
 * `failed` must never be presented as an issuer decline.
 */
export function providerIncrementOutcome(
  evidence: Pick<RevolutIncrementProviderEvidence, "increment_state">,
): "authorised" | "declined" | "failed" | "unsettled" | "unknown" {
  const s = String(evidence.increment_state ?? "");
  if (s === "authorised") return "authorised";
  if (s === "declined") return "declined";
  if (s === "failed") return "failed";
  if (s === "pending" || s === "processing") return "unsettled";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Webhook evidence (ORDER_INCREMENTAL_AUTHORISATION_*)
// ---------------------------------------------------------------------------

export const REVOLUT_INCREMENT_WEBHOOK_EVENTS = [
  "ORDER_INCREMENTAL_AUTHORISATION_AUTHORISED",
  "ORDER_INCREMENTAL_AUTHORISATION_DECLINED",
  "ORDER_INCREMENTAL_AUTHORISATION_FAILED",
] as const;

export type RevolutIncrementWebhookEvent = typeof REVOLUT_INCREMENT_WEBHOOK_EVENTS[number];

export function isRevolutIncrementWebhookEvent(
  eventName: unknown,
): eventName is RevolutIncrementWebhookEvent {
  return (REVOLUT_INCREMENT_WEBHOOK_EVENTS as readonly string[]).includes(
    String(eventName ?? "").trim().toUpperCase(),
  );
}

export function expectedIncrementStateForWebhook(
  eventName: RevolutIncrementWebhookEvent,
): ProviderIncrementState {
  if (eventName === "ORDER_INCREMENTAL_AUTHORISATION_AUTHORISED") return "authorised";
  if (eventName === "ORDER_INCREMENTAL_AUTHORISATION_DECLINED") return "declined";
  return "failed";
}

/**
 * Latest increment whose state matches the webhook event. Falls back to the
 * latest entry so the persisted row still records what Revolut returned.
 */
export function findIncrementForWebhook(
  order: RevolutOrder | null | undefined,
  eventName: RevolutIncrementWebhookEvent,
): { entry: IncrementEntry | null; stateMatchesEvent: boolean } {
  const list = Array.isArray(order?.incremental_authorisations)
    ? order!.incremental_authorisations!
    : [];
  const expected = expectedIncrementStateForWebhook(eventName);
  for (let i = list.length - 1; i >= 0; i--) {
    if (normalizeProviderIncrementState(list[i]?.state) === expected) {
      return { entry: list[i], stateMatchesEvent: true };
    }
  }
  return { entry: list.length > 0 ? list[list.length - 1] : null, stateMatchesEvent: false };
}

/**
 * Idempotency key for processed_revolut_events.event_id. Revolut's payload has
 * no event id, so identity is event + order + increment attempt + observed
 * state (a lagging retrieve that still shows `processing` must not block the
 * redelivery that observes the settled state). Unresolved receipts (retrieve
 * failed) are keyed by the signed request timestamp.
 */
export function buildIncrementWebhookEventId(args: {
  eventName: RevolutIncrementWebhookEvent;
  orderId: string;
  incrementReference?: string | null;
  incrementNewAmountPence?: number | null;
  incrementState?: string | null;
  requestTimestamp?: string | null;
}): string {
  const base = `revolut_increment_webhook:${args.eventName}:${String(args.orderId).trim()}`;
  const state = sanitizeProviderToken(args.incrementState, 40) ?? "none";
  const reference = sanitizeProviderToken(args.incrementReference, MAX_REFERENCE_LENGTH);
  if (reference) return `${base}:ref:${reference}:${state}`;
  const amount = minorOrNull(args.incrementNewAmountPence);
  if (amount != null && amount > 0) return `${base}:amount:${amount}:${state}`;
  return `${base}:unresolved:${String(args.requestTimestamp ?? "").trim() || "no_ts"}`;
}
