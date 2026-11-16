/**
 * confirm-revolut-payment wait budget SSOT.
 *
 * Customer Book sends max_wait_ms: 0 (single Revolut retrieve per tick) and
 * orchestrates short client polls. Hardcoding 22s server wait nested those
 * polls into multi-minute Book→Finding latency (not Uber/Bolt class).
 *
 * Caps:
 * - Booking confirm: ≤2s (align create-trip-after-payment fast verify)
 * - Save-card token confirm: ≤10s
 * - Explicit 0: one retrieve, no sleep
 */

export const CONFIRM_REVOLUT_BOOKING_CAP_MS = 2_000;
export const CONFIRM_REVOLUT_SAVE_CARD_CAP_MS = 10_000;

export type ConfirmRevolutWaitBody = {
  max_wait_ms?: unknown;
  expect_saved_card_token?: unknown;
};

export type ConfirmRevolutWaitResolved = {
  maxWaitMs: number;
  pollIntervalMs: number;
  /** True when body included a finite max_wait_ms (including 0). */
  clientSpecified: boolean;
};

export function resolveConfirmRevolutMaxWaitMs(
  body: ConfirmRevolutWaitBody,
): ConfirmRevolutWaitResolved {
  const isSaveCard = body.expect_saved_card_token === true;
  const cap = isSaveCard
    ? CONFIRM_REVOLUT_SAVE_CARD_CAP_MS
    : CONFIRM_REVOLUT_BOOKING_CAP_MS;

  const raw = Number(body.max_wait_ms);
  const clientSpecified =
    body.max_wait_ms !== undefined &&
    body.max_wait_ms !== null &&
    Number.isFinite(raw);
  const clientAsked = clientSpecified ? Math.max(0, Math.round(raw)) : null;

  const maxWaitMs =
    clientAsked != null ? Math.min(clientAsked, cap) : cap;

  return {
    maxWaitMs,
    pollIntervalMs: maxWaitMs === 0 ? 0 : isSaveCard ? 250 : 200,
    clientSpecified,
  };
}
