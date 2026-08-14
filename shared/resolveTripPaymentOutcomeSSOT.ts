/**
 * P0 — Canonical trip payment outcome resolver.
 *
 * Exactly one outcome per trip. No UI / ad-hoc edge may decide capture vs release
 * independently of this SSOT.
 */

export const TRIP_PAYMENT_OUTCOME = {
  CAPTURE_FULL: "CAPTURE_FULL",
  CAPTURE_AND_RELEASE_REMAINDER: "CAPTURE_AND_RELEASE_REMAINDER",
  ADDITIONAL_AUTHORISATION_REQUIRED: "ADDITIONAL_AUTHORISATION_REQUIRED",
  PAYMENT_RECOVERY_REQUIRED: "PAYMENT_RECOVERY_REQUIRED",
  RELEASE_FULL_HOLD: "RELEASE_FULL_HOLD",
  NO_ACTION_ALREADY_RESOLVED: "NO_ACTION_ALREADY_RESOLVED",
  MANUAL_REVIEW_REQUIRED: "MANUAL_REVIEW_REQUIRED",
} as const;

export type TripPaymentOutcome =
  typeof TRIP_PAYMENT_OUTCOME[keyof typeof TRIP_PAYMENT_OUTCOME];

const COMPLETED = new Set(["completed"]);
const CANCEL_LIKE = new Set([
  "cancelled",
  "canceled",
  "customer_cancelled",
  "customer_canceled",
  "driver_cancelled",
  "driver_canceled",
  "admin_cancelled",
  "admin_canceled",
]);
const NO_SHOW = new Set(["no_show"]);
const NEVER_TRIP_TERMINAL = new Set([
  "expired",
  "expired_no_driver",
  "abandoned",
  "failed",
  "declined",
  "rejected",
]);

const PROVIDER_AUTHORISED = new Set(["AUTHORISED", "AUTHORIZED", "PROCESSING", "PENDING", "ACTIVE_AUTHORISED"]);
const PROVIDER_CAPTURED = new Set(["COMPLETED", "CAPTURED"]);
const PROVIDER_RELEASED = new Set(["CANCELLED", "CANCELED", "REFUNDED", "REVERTED"]);

function pence(v: number | null | undefined): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

function normStatus(v: string | null | undefined): string {
  return String(v ?? "").trim().toLowerCase();
}

function normProvider(v: string | null | undefined): string {
  return String(v ?? "").trim().toUpperCase();
}

export type ResolveTripPaymentOutcomeInput = {
  trip_status?: string | null;
  /** Canonical customer payable for a completed trip (fare + waiting + extras + tip − discounts). */
  canonical_payable_pence?: number | null;
  /** Booking/estimate final fare — ignored for cancel/no-show owed. */
  final_fare_pence?: number | null;
  cancellation_fee_pence?: number | null;
  no_show_fee_pence?: number | null;
  total_authorised_pence?: number | null;
  total_captured_pence?: number | null;
  total_released_pence?: number | null;
  total_refunded_pence?: number | null;
  recovery_captured_pence?: number | null;
  outstanding_balance_pence?: number | null;
  /** Live or refreshed Revolut order state. */
  provider_state?: string | null;
  payment_status?: string | null;
  payment_hold_status?: string | null;
  recovery_required?: boolean | null;
  provider_state_unknown?: boolean | null;
};

export type ResolveTripPaymentOutcomeResult = {
  outcome: TripPaymentOutcome;
  canonical_payable_pence: number;
  capture_amount_pence: number;
  release_amount_pence: number;
  shortfall_pence: number;
  reason: string;
  provider_mutation_allowed: boolean;
  local_reconcile_only: boolean;
};

/**
 * Derive the amount the customer still owes for the trip lifecycle.
 * Cancel / no-show: fee only. Completed: canonical payable. Never booking fare on cancel.
 */
export function resolveCanonicalCustomerPayablePence(
  input: ResolveTripPaymentOutcomeInput,
): number {
  const status = normStatus(input.trip_status);
  if (NO_SHOW.has(status)) {
    return pence(input.no_show_fee_pence);
  }
  if (CANCEL_LIKE.has(status) || status.includes("cancel")) {
    return pence(input.cancellation_fee_pence);
  }
  if (COMPLETED.has(status)) {
    const canonical = pence(input.canonical_payable_pence);
    if (canonical > 0) return canonical;
    return pence(input.final_fare_pence);
  }
  if (NEVER_TRIP_TERMINAL.has(status)) {
    return 0;
  }
  // Active / unknown — do not invent a payable.
  return pence(input.canonical_payable_pence) || pence(input.final_fare_pence);
}

export function resolveTripPaymentOutcome(
  input: ResolveTripPaymentOutcomeInput,
): ResolveTripPaymentOutcomeResult {
  const status = normStatus(input.trip_status);
  const provider = normProvider(input.provider_state);
  const authorised = pence(input.total_authorised_pence);
  const captured = pence(input.total_captured_pence);
  const released = pence(input.total_released_pence);
  const recoveryCaptured = pence(input.recovery_captured_pence);
  const totalCaptured = captured + recoveryCaptured;
  const payable = resolveCanonicalCustomerPayablePence(input);
  const holdStatus = normStatus(input.payment_hold_status);
  const paymentStatus = normStatus(input.payment_status);

  const base = (
    outcome: TripPaymentOutcome,
    extra: Partial<ResolveTripPaymentOutcomeResult> & { reason: string },
  ): ResolveTripPaymentOutcomeResult => ({
    outcome,
    canonical_payable_pence: payable,
    capture_amount_pence: 0,
    release_amount_pence: 0,
    shortfall_pence: 0,
    provider_mutation_allowed: false,
    local_reconcile_only: false,
    ...extra,
  });

  if (input.provider_state_unknown === true) {
    return base(TRIP_PAYMENT_OUTCOME.MANUAL_REVIEW_REQUIRED, {
      reason: "provider_state_unknown",
    });
  }

  // Provider already terminal + money settled → local reconcile only.
  if (PROVIDER_RELEASED.has(provider) && totalCaptured <= 0 && payable === 0) {
    const localOpen = holdStatus === "authorised_hold"
      || paymentStatus === "authorized"
      || paymentStatus === "authorised"
      || paymentStatus === "capture_failed";
    if (localOpen || released <= 0) {
      return base(TRIP_PAYMENT_OUTCOME.NO_ACTION_ALREADY_RESOLVED, {
        reason: "provider_already_cancelled_local_reconcile",
        local_reconcile_only: true,
        release_amount_pence: authorised > 0 ? authorised : 0,
      });
    }
    return base(TRIP_PAYMENT_OUTCOME.NO_ACTION_ALREADY_RESOLVED, {
      reason: "already_released",
      local_reconcile_only: false,
    });
  }

  if (PROVIDER_CAPTURED.has(provider) && totalCaptured > 0) {
    const net = Math.max(0, totalCaptured - pence(input.total_refunded_pence));
    if (payable > 0 && Math.abs(net - payable) <= 1) {
      return base(TRIP_PAYMENT_OUTCOME.NO_ACTION_ALREADY_RESOLVED, {
        reason: "already_captured_matches_payable",
        capture_amount_pence: payable,
        // Captured trips are terminal — do not run cancel/release local reconcile.
        local_reconcile_only: false,
      });
    }
    if (payable > 0 && net < payable) {
      return base(TRIP_PAYMENT_OUTCOME.PAYMENT_RECOVERY_REQUIRED, {
        reason: "captured_below_payable",
        shortfall_pence: payable - net,
        capture_amount_pence: net,
      });
    }
    return base(TRIP_PAYMENT_OUTCOME.NO_ACTION_ALREADY_RESOLVED, {
      reason: "provider_already_captured",
      capture_amount_pence: net,
      local_reconcile_only: false,
    });
  }

  if (input.recovery_required === true || holdStatus === "payment_shortfall") {
    return base(TRIP_PAYMENT_OUTCOME.PAYMENT_RECOVERY_REQUIRED, {
      reason: "recovery_flagged",
      shortfall_pence: Math.max(0, payable - totalCaptured),
    });
  }

  // Cancel / no-show / never-created terminal with £0 fee.
  if (
    CANCEL_LIKE.has(status)
    || status.includes("cancel")
    || NO_SHOW.has(status)
    || NEVER_TRIP_TERMINAL.has(status)
  ) {
    if (payable === 0) {
      if (PROVIDER_RELEASED.has(provider)) {
        return base(TRIP_PAYMENT_OUTCOME.NO_ACTION_ALREADY_RESOLVED, {
          reason: "zero_fee_provider_already_released",
          local_reconcile_only: true,
          release_amount_pence: authorised,
        });
      }
      if (PROVIDER_AUTHORISED.has(provider) || !provider) {
        return base(TRIP_PAYMENT_OUTCOME.RELEASE_FULL_HOLD, {
          reason: "zero_fee_terminal_release",
          release_amount_pence: authorised,
          provider_mutation_allowed: PROVIDER_AUTHORISED.has(provider),
        });
      }
      return base(TRIP_PAYMENT_OUTCOME.MANUAL_REVIEW_REQUIRED, {
        reason: `zero_fee_unexpected_provider_${provider || "missing"}`,
      });
    }

    // Fee owed on cancel/no-show.
    if (PROVIDER_AUTHORISED.has(provider) && authorised >= payable) {
      return base(TRIP_PAYMENT_OUTCOME.CAPTURE_AND_RELEASE_REMAINDER, {
        reason: NO_SHOW.has(status) ? "no_show_fee_capture" : "cancellation_fee_capture",
        capture_amount_pence: payable,
        release_amount_pence: Math.max(0, authorised - payable),
        provider_mutation_allowed: true,
      });
    }
    if (PROVIDER_AUTHORISED.has(provider) && authorised < payable) {
      return base(TRIP_PAYMENT_OUTCOME.ADDITIONAL_AUTHORISATION_REQUIRED, {
        reason: "fee_exceeds_authorisation",
        capture_amount_pence: authorised,
        shortfall_pence: payable - authorised,
        provider_mutation_allowed: true,
      });
    }
    return base(TRIP_PAYMENT_OUTCOME.MANUAL_REVIEW_REQUIRED, {
      reason: "fee_owed_provider_not_authorised",
    });
  }

  // Completed trip.
  if (COMPLETED.has(status)) {
    if (payable <= 0) {
      if (PROVIDER_AUTHORISED.has(provider)) {
        return base(TRIP_PAYMENT_OUTCOME.RELEASE_FULL_HOLD, {
          reason: "completed_zero_payable_release",
          release_amount_pence: authorised,
          provider_mutation_allowed: true,
        });
      }
      return base(TRIP_PAYMENT_OUTCOME.NO_ACTION_ALREADY_RESOLVED, {
        reason: "completed_zero_payable",
        local_reconcile_only: true,
      });
    }

    if (totalCaptured >= payable) {
      return base(TRIP_PAYMENT_OUTCOME.NO_ACTION_ALREADY_RESOLVED, {
        reason: "completed_already_captured",
        capture_amount_pence: payable,
        local_reconcile_only: true,
      });
    }

    if (!PROVIDER_AUTHORISED.has(provider) && !PROVIDER_CAPTURED.has(provider)) {
      if (paymentStatus === "capture_failed" && !provider) {
        return base(TRIP_PAYMENT_OUTCOME.MANUAL_REVIEW_REQUIRED, {
          reason: "capture_failed_provider_missing",
        });
      }
      return base(TRIP_PAYMENT_OUTCOME.MANUAL_REVIEW_REQUIRED, {
        reason: `completed_unexpected_provider_${provider || "missing"}`,
      });
    }

    if (authorised < payable) {
      return base(TRIP_PAYMENT_OUTCOME.ADDITIONAL_AUTHORISATION_REQUIRED, {
        reason: "final_exceeds_authorisation",
        capture_amount_pence: authorised,
        shortfall_pence: payable - authorised,
        provider_mutation_allowed: true,
      });
    }

    if (authorised === payable) {
      return base(TRIP_PAYMENT_OUTCOME.CAPTURE_FULL, {
        reason: "capture_full_canonical",
        capture_amount_pence: payable,
        provider_mutation_allowed: true,
      });
    }

    return base(TRIP_PAYMENT_OUTCOME.CAPTURE_AND_RELEASE_REMAINDER, {
      reason: "capture_canonical_release_remainder",
      capture_amount_pence: payable,
      release_amount_pence: Math.max(0, authorised - payable),
      provider_mutation_allowed: true,
    });
  }

  // Orphan auth / trip never created (no trip status or pre-trip).
  if (!status || status === "searching") {
    if (PROVIDER_AUTHORISED.has(provider) && payable === 0) {
      return base(TRIP_PAYMENT_OUTCOME.RELEASE_FULL_HOLD, {
        reason: "orphan_or_pretrip_release",
        release_amount_pence: authorised,
        provider_mutation_allowed: true,
      });
    }
  }

  return base(TRIP_PAYMENT_OUTCOME.MANUAL_REVIEW_REQUIRED, {
    reason: `unclassified_status_${status || "empty"}`,
  });
}
