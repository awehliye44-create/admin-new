/**
 * Pre-Authorization Buffer (PAYMENT layer)
 *
 * STRICT RULES — DO NOT VIOLATE:
 *   • This is a PAYMENT AUTHORIZATION concern, NOT a fare pricing concern.
 *   • The buffer is added ONLY to the Stripe pre-auth HOLD amount.
 *   • It is NEVER part of the fare.
 *   • It is NEVER part of driver earnings or commission.
 *   • It is NEVER captured — Stripe releases unused hold automatically when
 *     `capture-trip-payment` captures only the actual final fare.
 *   • At capture time we capture `final_fare_pence` only.
 */

export interface PreauthBufferConfig {
  enable_preauth_buffer: boolean;
  buffer_type: "fixed" | "percentage";
  buffer_value: number; // fixed: currency units (e.g. 1.50). percentage: percent (e.g. 20)
  min_hold_pence: number | null;
  max_hold_pence: number | null;
}

export interface PreauthHoldResult {
  /** Final amount Stripe will hold on the customer's card (>= payable_pence). */
  hold_pence: number;
  /** Buffer added on top of payable_pence to compute hold_pence. */
  buffer_pence: number;
  /** Was the buffer applied (vs disabled / no-op)? */
  applied: boolean;
  reason?: string;
}

/**
 * Compute the Stripe pre-authorization hold from the payable amount.
 *
 * @param payablePence  estimated_fare - discount (what we will MAX capture).
 * @param cfg           per-service-area pre-auth buffer config (or null = disabled).
 *
 * Returned hold_pence is what we pass to Stripe as `amount`. The actual
 * captured amount is determined later by `capture-trip-payment` based on the
 * real final fare — Stripe releases the unused difference automatically.
 */
export function computePreauthHold(
  payablePence: number,
  cfg: PreauthBufferConfig | null | undefined,
): PreauthHoldResult {
  // Always work with a non-negative payable amount.
  const payable = Math.max(0, Math.round(payablePence));

  if (!cfg || !cfg.enable_preauth_buffer || cfg.buffer_value <= 0) {
    return {
      hold_pence: payable,
      buffer_pence: 0,
      applied: false,
      reason: "buffer_disabled_or_zero",
    };
  }

  let bufferPence: number;
  if (cfg.buffer_type === "fixed") {
    bufferPence = Math.round(cfg.buffer_value * 100);
  } else {
    bufferPence = Math.round((payable * cfg.buffer_value) / 100);
  }
  bufferPence = Math.max(0, bufferPence);

  let hold = payable + bufferPence;

  // Optional clamps. min_hold_pence is an absolute MINIMUM hold value.
  if (cfg.min_hold_pence != null && hold < cfg.min_hold_pence) {
    hold = cfg.min_hold_pence;
  }
  // max_hold_pence is an absolute MAXIMUM hold value (never reduce below payable).
  if (cfg.max_hold_pence != null && hold > cfg.max_hold_pence) {
    hold = Math.max(payable, cfg.max_hold_pence);
  }

  // Defensive: hold must never be lower than payable, otherwise we couldn't capture.
  if (hold < payable) hold = payable;

  return {
    hold_pence: hold,
    buffer_pence: hold - payable,
    applied: hold > payable,
  };
}
