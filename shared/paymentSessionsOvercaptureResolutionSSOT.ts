/**
 * Payment Sessions overcapture resolution (presentation / reconciliation only).
 *
 * Gross unexplained overcapture stays visible as historical evidence.
 * Outstanding customer overcharge nets provider-confirmed refunds against
 * expected capture — never invents fares or mutates payment rows.
 */

export type OvercaptureResolutionInput = {
  /** Canonical expected capture (PS breakdown). */
  expected_capture_pence: number | null;
  /** Provider-confirmed captured amount. */
  provider_captured_pence: number | null;
  /** Provider-confirmed refunded amount. Null ≠ £0. */
  refunded_amount_pence: number | null;
  /**
   * Gross unexplained overcapture for this row (actual − expected when
   * classified UNEXPLAINED_OVERCAPTURE). Null/≤0 → no overcapture resolution.
   */
  gross_overcapture_pence: number | null;
};

export type OvercaptureResolutionResult = {
  gross_overcapture_pence: number;
  net_charged_pence: number | null;
  /** max(0, net_charged − expected) — money still above payable after refunds. */
  outstanding_customer_overcharge_pence: number;
  /** Portion of gross overcapture covered by refunds: min(gross, refunded). */
  resolved_overcapture_pence: number;
  /**
   * Refund above the gross overcapture (e.g. £6 refund on £3 excess).
   * Kept visible for FR — never silently netted into “resolved”.
   */
  refund_beyond_gross_overcapture_pence: number;
};

function confirmedNonNeg(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * Derive outstanding vs resolved overcapture from existing PS amounts.
 * Does not invent expected capture or refunds.
 */
export function resolveOvercaptureCustomerPosition(
  input: OvercaptureResolutionInput,
): OvercaptureResolutionResult {
  const gross = Math.max(0, confirmedNonNeg(input.gross_overcapture_pence) ?? 0);
  const expected = confirmedNonNeg(input.expected_capture_pence);
  const captured = confirmedNonNeg(input.provider_captured_pence);
  const refunded = confirmedNonNeg(input.refunded_amount_pence) ?? 0;

  const netCharged = captured == null ? null : Math.max(0, captured - refunded);

  let outstanding = 0;
  if (gross > 0 && expected != null && netCharged != null) {
    outstanding = Math.max(0, netCharged - expected);
  }

  const resolved = Math.min(gross, refunded);
  const beyond = Math.max(0, refunded - gross);

  return {
    gross_overcapture_pence: gross,
    net_charged_pence: netCharged,
    outstanding_customer_overcharge_pence: outstanding,
    resolved_overcapture_pence: resolved,
    refund_beyond_gross_overcapture_pence: beyond,
  };
}

export function sumOvercaptureResolutionTotals(
  rows: OvercaptureResolutionResult[],
): {
  gross_overcapture_pence: number | null;
  resolved_overcapture_pence: number | null;
  outstanding_customer_overcharge_pence: number | null;
  refund_beyond_gross_overcapture_pence: number | null;
} {
  let gross = 0;
  let resolved = 0;
  let outstanding = 0;
  let beyond = 0;
  let any = false;
  for (const row of rows) {
    if (row.gross_overcapture_pence <= 0) continue;
    any = true;
    gross += row.gross_overcapture_pence;
    resolved += row.resolved_overcapture_pence;
    outstanding += row.outstanding_customer_overcharge_pence;
    beyond += row.refund_beyond_gross_overcapture_pence;
  }
  if (!any) {
    return {
      gross_overcapture_pence: null,
      resolved_overcapture_pence: null,
      outstanding_customer_overcharge_pence: null,
      refund_beyond_gross_overcapture_pence: null,
    };
  }
  return {
    gross_overcapture_pence: gross,
    resolved_overcapture_pence: resolved,
    outstanding_customer_overcharge_pence: outstanding,
    refund_beyond_gross_overcapture_pence: beyond,
  };
}
