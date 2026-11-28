/**
 * Revolut incremental-authorisation provider evidence (pure helpers).
 *
 * Documented contract (Merchant API 2026-04-20):
 *   incremental_authorisations[].state   pending | processing | authorised | declined | failed
 *   incremental_authorisations[].reason  present only when state is declined or failed
 *   declined = declined by the card issuer / card network
 *   failed   = technical error, NOT an issuer decline
 *
 * Evidence is an allow-list of scalar fields. Card numbers, CVV, payment
 * tokens, last_four, checkout URLs and customer data are never copied.
 *
 * Bug #18 Tier A: enrich method/brand/order/timestamps without changing
 * payment behaviour.
 */

import type { RevolutOrder } from "./revolutOrders.ts";

export type ProviderIncrementState =
  | "pending"
  | "processing"
  | "authorised"
  | "declined"
  | "failed";

export type IncrementAttemptMatch = "reference" | "target_amount" | "latest" | null;

/** Allow-listed wallet / card method labels for telemetry only. */
export type IncrementPaymentMethodType =
  | "card"
  | "apple_pay"
  | "google_pay"
  | "unknown";

export type RevolutIncrementProviderEvidence = {
  evidence_source: "post_response" | "retrieve" | "webhook_retrieve";
  captured_at: string;
  /** When ONECAB started the provider round-trip (ISO). */
  request_started_at: string | null;
  /** When ONECAB finished building this evidence snapshot (ISO). */
  response_completed_at: string | null;
  /** Revolut order id (UUID) — not a payment token. */
  provider_order_id: string | null;
  /** Our idempotent increment reference sent to Revolut. */
  increment_request_reference: string | null;
  increment_state: ProviderIncrementState | string | null;
  increment_reason: string | null;
  increment_reason_field: "reason" | "decline_reason" | null;
  /** Provider increment object id when present (not a card token). */
  increment_id: string | null;
  /** Revolut-side created_at on the increment object when present. */
  increment_created_at: string | null;
  increment_old_amount_pence: number | null;
  increment_new_amount_pence: number | null;
  /** Delta = target − previous (requested increase), never a second order. */
  requested_increment_delta_pence: number | null;
  increment_reference: string | null;
  increment_matched_by: IncrementAttemptMatch;
  increment_attempt_count: number;
  requested_target_total_pence: number | null;
  previous_authorised_total_pence: number | null;
  payment_method_type: IncrementPaymentMethodType | string | null;
  /** Scheme/brand only (visa/mastercard/…). Never last_four. */
  card_brand: string | null;
  payment_state: string | null;
  payment_amount_pence: number | null;
  payment_authorised_amount_pence: number | null;
  payment_decline_reason: string | null;
  order_state: string | null;
  /** Order authorisation_type (e.g. pre_authorisation). */
  authorisation_type: string | null;
  /** Order capture_mode (e.g. manual). */
  capture_mode: string | null;
  provider_authorised_total_pence: number | null;
  /**
   * After a declined/failed attempt: order_state + authorised total still on
   * the original hold (issuer decline leaves prior auth valid).
   */
  original_authorisation_status_after_attempt: string | null;
  post_http_status: number | null;
  post_http_ok: boolean | null;
  /** Normalised outcome for this snapshot. */
  processing_outcome: "authorised" | "declined" | "failed" | "unsettled" | "unknown";
};

type IncrementEntry = NonNullable<RevolutOrder["incremental_authorisations"]>[number];

const MAX_REASON_LENGTH = 200;
const MAX_REFERENCE_LENGTH = 100;
const MAX_BRAND_LENGTH = 40;
const MAX_ORDER_ID_LENGTH = 80;

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

export function normalizeIncrementPaymentMethodType(
  value: unknown,
): IncrementPaymentMethodType | string | null {
  const s = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!s) return null;
  if (s === "card" || s === "revolut_pay_card") return "card";
  if (s === "apple_pay" || s === "applepay") return "apple_pay";
  if (s === "google_pay" || s === "googlepay") return "google_pay";
  if (s === "unknown") return "unknown";
  return sanitizeProviderToken(s, MAX_BRAND_LENGTH);
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
 * Brand / scheme from payment_method — never last_four, never nested card PAN.
 */
export function readPaymentMethodBrand(paymentMethod: unknown): string | null {
  if (!paymentMethod || typeof paymentMethod !== "object") return null;
  const rec = paymentMethod as Record<string, unknown>;
  return (
    sanitizeProviderToken(rec.card_brand, MAX_BRAND_LENGTH) ??
    sanitizeProviderToken(rec.brand, MAX_BRAND_LENGTH) ??
    null
  );
}

export function readPaymentMethodTypeFromPayment(paymentMethod: unknown): string | null {
  if (!paymentMethod || typeof paymentMethod !== "object") return null;
  const rec = paymentMethod as Record<string, unknown>;
  return normalizeIncrementPaymentMethodType(rec.type);
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

/**
 * Provider outcome of the attempt, independent of ONECAB coverage math.
 * `failed` must never be presented as an issuer decline.
 */
export function providerIncrementOutcome(
  evidence: Pick<RevolutIncrementProviderEvidence, "increment_state"> | {
    increment_state?: string | null;
  },
): "authorised" | "declined" | "failed" | "unsettled" | "unknown" {
  const s = String(evidence.increment_state ?? "");
  if (s === "authorised") return "authorised";
  if (s === "declined") return "declined";
  if (s === "failed") return "failed";
  if (s === "pending" || s === "processing") return "unsettled";
  return "unknown";
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
  requestStartedAtIso?: string | null;
  providerOrderId?: string | null;
  /** Session / eligibility method when known (card / apple_pay / google_pay). */
  paymentMethodType?: string | null;
}): RevolutIncrementProviderEvidence {
  const nowIso = args.nowIso ?? new Date().toISOString();
  const attempt = findIncrementAttempt(args.order, {
    reference: args.reference,
    targetTotalPence: args.targetTotalPence,
  });
  const reason = readIncrementProviderReason(attempt.entry);
  const payments = Array.isArray(args.order?.payments) ? args.order!.payments! : [];
  const payment = payments.length > 0 ? payments[payments.length - 1] : null;
  const fromPayment = payment?.payment_method
    ? readPaymentMethodTypeFromPayment(payment.payment_method)
    : null;
  const paymentMethodType =
    normalizeIncrementPaymentMethodType(args.paymentMethodType) ??
    fromPayment ??
    null;
  const cardBrand = payment?.payment_method
    ? readPaymentMethodBrand(payment.payment_method)
    : null;
  const previous = minorOrNull(args.previousAuthorisedTotalPence);
  const target = minorOrNull(args.targetTotalPence);
  const delta =
    previous != null && target != null && target >= previous
      ? target - previous
      : null;
  const incrementState = attempt.entry
    ? normalizeProviderIncrementState(attempt.entry.state)
    : null;
  const outcome = providerIncrementOutcome({ increment_state: incrementState });
  const orderState = args.order ? sanitizeProviderToken(args.order.state, 40) : null;
  const providerAuthorised = minorOrNull(args.providerAuthorisedTotalPence);
  const requestRef =
    sanitizeProviderToken(args.reference, MAX_REFERENCE_LENGTH) ??
    (attempt.entry
      ? sanitizeProviderToken(attempt.entry.reference, MAX_REFERENCE_LENGTH)
      : null);

  return {
    evidence_source: args.evidenceSource,
    captured_at: nowIso,
    request_started_at: sanitizeProviderToken(args.requestStartedAtIso, 40),
    response_completed_at: nowIso,
    provider_order_id: sanitizeProviderToken(args.providerOrderId, MAX_ORDER_ID_LENGTH),
    increment_request_reference: requestRef,
    increment_state: incrementState,
    increment_reason: reason.reason,
    increment_reason_field: reason.field,
    increment_id: attempt.entry
      ? sanitizeProviderToken((attempt.entry as { id?: unknown }).id, MAX_REFERENCE_LENGTH)
      : null,
    increment_created_at: attempt.entry
      ? sanitizeProviderToken(attempt.entry.created_at, 40)
      : null,
    increment_old_amount_pence: attempt.entry ? minorOrNull(attempt.entry.old_amount) : null,
    increment_new_amount_pence: attempt.entry
      ? minorOrNull(attempt.entry.new_amount ?? attempt.entry.amount)
      : null,
    requested_increment_delta_pence: delta,
    increment_reference: attempt.entry
      ? sanitizeProviderToken(attempt.entry.reference, MAX_REFERENCE_LENGTH)
      : null,
    increment_matched_by: attempt.matchedBy,
    increment_attempt_count: attempt.count,
    requested_target_total_pence: target,
    previous_authorised_total_pence: previous,
    payment_method_type: paymentMethodType,
    card_brand: cardBrand,
    payment_state: payment ? sanitizeProviderToken(payment.state, 40) : null,
    payment_amount_pence: payment ? minorOrNull(payment.amount) : null,
    payment_authorised_amount_pence: payment ? minorOrNull(payment.authorised_amount) : null,
    payment_decline_reason: payment ? sanitizeProviderToken(payment.decline_reason) : null,
    order_state: orderState,
    authorisation_type: args.order
      ? sanitizeProviderToken(args.order.authorisation_type, 40)
      : null,
    capture_mode: args.order ? sanitizeProviderToken(args.order.capture_mode, 40) : null,
    provider_authorised_total_pence: providerAuthorised,
    original_authorisation_status_after_attempt:
      outcome === "declined" || outcome === "failed"
        ? sanitizeProviderToken(
          [
            orderState ?? "unknown_order_state",
            providerAuthorised != null ? `authorised_total_pence=${providerAuthorised}` : null,
          ].filter(Boolean).join("|"),
          120,
        )
        : null,
    post_http_status: args.postHttpStatus ?? null,
    post_http_ok: args.postHttpOk ?? null,
    processing_outcome: outcome,
  };
}

/** Forbidden substrings — evidence must never contain these keys/values. */
export const INCREMENT_EVIDENCE_FORBIDDEN_TOKENS = [
  "last_four",
  "card_last_four",
  "cvv",
  "cvc",
  "pan",
  "card_number",
  "number",
  "token",
  "acs_url",
  "client_secret",
  "password",
] as const;

// ---------------------------------------------------------------------------
// Webhook evidence (ORDER_INCREMENTAL_AUTHORISATION_*)
// ---------------------------------------------------------------------------

export const REVOLUT_INCREMENT_WEBHOOK_EVENTS = [
  "ORDER_INCREMENTAL_AUTHORISATION_AUTHORISED",
  "ORDER_INCREMENTAL_AUTHORISATION_DECLINED",
  "ORDER_INCREMENTAL_AUTHORISATION_FAILED",
] as const;

export type RevolutIncrementWebhookEvent = typeof REVOLUT_INCREMENT_WEBHOOK_EVENTS[number];

