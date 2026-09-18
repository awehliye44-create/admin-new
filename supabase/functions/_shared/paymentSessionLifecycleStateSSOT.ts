/**
 * Canonical payment-session lifecycle provider-state vocabulary.
 *
 * Raw Revolut order/payment/webhook strings (incl. ORDER_* event names and
 * PAYMENT_FAILED) must pass through normalizeLifecycleProviderState before
 * rank, regression, or webhook lifecycle decisions.
 *
 * lifecycle_provider_state from savedCardPaymentReconcileSSOT MUST already be
 * in this vocabulary (FAILED not PAYMENT_FAILED).
 *
 * Lock: paymentSessionLifecycleStateLock.test.ts + paymentSessionWebhookLifecycleLock
 */

export const CANONICAL_LIFECYCLE_PROVIDER_STATES = [
  "FAILED",
  "DECLINED",
  "CANCELLED",
  "AUTHORISED",
  "PROCESSING",
  "AUTHENTICATION_CHALLENGE",
  "COMPLETED",
  "CAPTURED",
  "REFUNDED",
  "REVERSED",
  "EXPIRED",
  "UNKNOWN",
] as const;

export type CanonicalLifecycleProviderState =
  (typeof CANONICAL_LIFECYCLE_PROVIDER_STATES)[number];

const ORDER_PREFIX = /^ORDER_/;

/**
 * Strip ORDER_ webhook prefix and map synonyms onto the canonical vocabulary.
 *
 * Exact mappings (required):
 * - PAYMENT_FAILED / FAILED / ORDER_PAYMENT_FAILED → FAILED
 * - DECLINED / ORDER_PAYMENT_DECLINED → DECLINED
 * - CANCELLED / CANCELED → CANCELLED
 * - AUTHENTICATION_CHALLENGE → AUTHENTICATION_CHALLENGE
 * - AUTHORISED / AUTHORIZED → AUTHORISED
 * - PENDING / PROCESSING / PAYMENT_PROCESSING → PROCESSING
 * - COMPLETED / CAPTURED / REFUNDED / REVERSED preserved
 */
export function normalizeLifecycleProviderState(
  raw: string | null | undefined,
): CanonicalLifecycleProviderState {
  let s = String(raw ?? "").trim().toUpperCase();
  if (!s) return "UNKNOWN";
  if (ORDER_PREFIX.test(s)) s = s.replace(ORDER_PREFIX, "");

  if (s === "PAYMENT_FAILED" || s === "FAILED") return "FAILED";
  if (s === "DECLINED" || s === "PAYMENT_DECLINED") return "DECLINED";
  if (s === "CANCELLED" || s === "CANCELED") return "CANCELLED";
  if (s === "AUTHENTICATION_CHALLENGE") return "AUTHENTICATION_CHALLENGE";
  if (s === "AUTHORISED" || s === "AUTHORIZED") return "AUTHORISED";
  if (
    s === "PENDING" ||
    s === "PROCESSING" ||
    s === "PAYMENT_PROCESSING" ||
    s === "PAYMENT_AUTHENTICATED"
  ) {
    return "PROCESSING";
  }
  if (s === "COMPLETED") return "COMPLETED";
  if (s === "CAPTURED") return "CAPTURED";
  if (s === "REFUNDED") return "REFUNDED";
  if (s === "REVERSED") return "REVERSED";
  if (s === "EXPIRED") return "EXPIRED";
  return "UNKNOWN";
}

/** Terminal-negative canonical states that advance session to failed/cancelled. */
export function isCanonicalTerminalNegative(
  state: CanonicalLifecycleProviderState | string | null | undefined,
): boolean {
  const n = typeof state === "string" &&
      (CANONICAL_LIFECYCLE_PROVIDER_STATES as readonly string[]).includes(state)
    ? state as CanonicalLifecycleProviderState
    : normalizeLifecycleProviderState(state);
  return n === "FAILED" || n === "DECLINED" || n === "CANCELLED";
}

/** Session status target for a terminal-negative canonical provider state. */
export function terminalNegativeSessionStatus(
  state: CanonicalLifecycleProviderState | string | null | undefined,
): "failed" | "cancelled" {
  const n = normalizeLifecycleProviderState(state);
  return n === "CANCELLED" ? "cancelled" : "failed";
}

/** True when canonical state is already capture/authorisation terminal-positive. */
export function isCanonicalAuthorisedOrCaptured(
  state: CanonicalLifecycleProviderState | string | null | undefined,
): boolean {
  const n = normalizeLifecycleProviderState(state);
  return n === "AUTHORISED" || n === "COMPLETED" || n === "CAPTURED";
}
