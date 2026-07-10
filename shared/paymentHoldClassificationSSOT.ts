/**
 * Payment Holds Attention SSOT — classification, provider mapping, money-at-risk.
 * Shared by edge functions and unit tests. No Deno-only imports.
 */

export type PaymentHoldTrafficLight = "GREEN" | "AMBER" | "RED" | "RESOLVED";

export type PaymentHoldAttentionClass =
  | "ACTIVE_AUTHORISED_HOLD"
  | "RECOVERY_PENDING"
  | "RELEASE_PENDING"
  | "RELEASE_FAILED"
  | "RESOLVED_PROVIDER_CANCELLED"
  | "RESOLVED_PROVIDER_REVERTED"
  | "RESOLVED_COMPANION_SESSION"
  | "CAPTURED"
  | "REFUNDED"
  | "LEGACY_EVIDENCE"
  | "UNKNOWN_PROVIDER_STATE"
  | "OK_ACTIVE_TRIP";

/** Legacy traffic-light badge used by admin UI. */
export type PaymentHoldClassification = "GREEN" | "AMBER" | "RED";

export type CanonicalProviderHoldState =
  | "ACTIVE_AUTHORISED"
  | "PENDING"
  | "PROCESSING"
  | "CAPTURED"
  | "CANCELLED"
  | "REVERTED"
  | "FAILED"
  | "REFUNDED"
  | "UNKNOWN";

export const ACTIVE_ATTENTION_CLASSES = new Set<PaymentHoldAttentionClass>([
  "ACTIVE_AUTHORISED_HOLD",
  "RECOVERY_PENDING",
  "RELEASE_PENDING",
  "RELEASE_FAILED",
  "UNKNOWN_PROVIDER_STATE",
]);

export function mapRevolutProviderHoldState(
  state: string | null | undefined,
): CanonicalProviderHoldState {
  const upper = String(state ?? "").trim().toUpperCase();
  switch (upper) {
    case "AUTHORISED":
    case "AUTHORIZED":
      return "ACTIVE_AUTHORISED";
    case "PENDING":
      return "PENDING";
    case "PROCESSING":
      return "PROCESSING";
    case "COMPLETED":
      return "CAPTURED";
    case "CANCELLED":
    case "CANCELED":
      return "CANCELLED";
    case "REVERTED":
      return "REVERTED";
    case "FAILED":
      return "FAILED";
    case "REFUNDED":
      return "REFUNDED";
    default:
      return "UNKNOWN";
  }
}

export function isTerminalResolvedProviderState(
  state: CanonicalProviderHoldState,
): boolean {
  return (
    state === "CANCELLED"
    || state === "REVERTED"
    || state === "CAPTURED"
    || state === "REFUNDED"
    || state === "FAILED"
  );
}

export function providerTerminalReason(
  state: CanonicalProviderHoldState,
):
  | "PROVIDER_CANCELLED"
  | "PROVIDER_REVERTED"
  | "PROVIDER_CAPTURED"
  | "PROVIDER_REFUNDED"
  | "PROVIDER_FAILED"
  | null {
  switch (state) {
    case "CANCELLED":
      return "PROVIDER_CANCELLED";
    case "REVERTED":
      return "PROVIDER_REVERTED";
    case "CAPTURED":
      return "PROVIDER_CAPTURED";
    case "REFUNDED":
      return "PROVIDER_REFUNDED";
    case "FAILED":
      return "PROVIDER_FAILED";
    default:
      return null;
  }
}

export type HoldActionPolicy = {
  can_release: boolean;
  can_retry_release: boolean;
  can_retry_recovery: boolean;
  can_refund: boolean;
  can_open_trip: boolean;
};

export function paymentHoldActionPolicy(args: {
  attentionClass: PaymentHoldAttentionClass;
  hasTrip: boolean;
  recoveryAttemptCount?: number;
  releaseFailureReason?: string | null;
  capturedAt?: string | null;
  fullyRefunded?: boolean;
}): HoldActionPolicy {
  if (!ACTIVE_ATTENTION_CLASSES.has(args.attentionClass)) {
    return {
      can_release: false,
      can_retry_release: false,
      can_retry_recovery: false,
      can_refund: args.attentionClass === "CAPTURED"
        && Boolean(args.capturedAt)
        && !args.fullyRefunded,
      can_open_trip: args.hasTrip,
    };
  }

  if (args.attentionClass === "RELEASE_FAILED") {
    return {
      can_release: true,
      can_retry_release: true,
      can_retry_recovery: false,
      can_refund: false,
      can_open_trip: args.hasTrip,
    };
  }

  if (args.attentionClass === "RELEASE_PENDING") {
    return {
      can_release: false,
      can_retry_release: false,
      can_retry_recovery: false,
      can_refund: false,
      can_open_trip: args.hasTrip,
    };
  }

  if (args.attentionClass === "RECOVERY_PENDING") {
    return {
      can_release: true,
      can_retry_release: Boolean(args.releaseFailureReason),
      can_retry_recovery: (args.recoveryAttemptCount ?? 0) < 1,
      can_refund: false,
      can_open_trip: args.hasTrip,
    };
  }

  return {
    can_release: true,
    can_retry_release: Boolean(args.releaseFailureReason),
    can_retry_recovery: !args.hasTrip && (args.recoveryAttemptCount ?? 0) < 1,
    can_refund: false,
    can_open_trip: args.hasTrip,
  };
}

export function legacyHoldClassificationLabel(
  attentionClass: PaymentHoldAttentionClass,
):
  | "OK_ACTIVE_TRIP"
  | "OK_COMPLETED_CAPTURED"
  | "OK_CANCELLED_RELEASED"
  | "BLOCKED_HOLD_NO_TRIP"
  | "BLOCKED_CANCELLED_NOT_RELEASED"
  | "BLOCKED_EXPIRED_NOT_RELEASED"
  | "BLOCKED_RELEASE_FAILED"
  | "BLOCKED_UNKNOWN_STATE" {
  switch (attentionClass) {
    case "OK_ACTIVE_TRIP":
      return "OK_ACTIVE_TRIP";
    case "CAPTURED":
      return "OK_COMPLETED_CAPTURED";
    case "RESOLVED_PROVIDER_CANCELLED":
    case "RESOLVED_PROVIDER_REVERTED":
    case "RESOLVED_COMPANION_SESSION":
    case "REFUNDED":
    case "LEGACY_EVIDENCE":
      return "OK_CANCELLED_RELEASED";
    case "RELEASE_FAILED":
    case "RELEASE_PENDING":
      return "BLOCKED_RELEASE_FAILED";
    case "ACTIVE_AUTHORISED_HOLD":
    case "RECOVERY_PENDING":
      return "BLOCKED_HOLD_NO_TRIP";
    default:
      return "BLOCKED_UNKNOWN_STATE";
  }
}

const TERMINAL_TRIP = new Set([
  "cancelled",
  "customer_cancelled",
  "driver_cancelled",
  "expired",
  "expired_no_driver",
  "no_show",
  "failed",
  "declined",
  "abandoned",
  "rejected",
]);

function fromDbSessionStatus(status: string | null | undefined): string {
  switch (status) {
    case "pending_payment":
      return "created";
    case "authorising":
      return "checkout_open";
    case "payment_authorised":
      return "authorised_hold";
    case "payment_orphaned":
      return "orphan_authorisation";
    case "cancelled":
      return "released";
    default:
      return status ?? "created";
  }
}

function isAuthorisedSession(status: string | null | undefined): boolean {
  const c = fromDbSessionStatus(status);
  return c === "authorised_hold" || c === "trip_created" || c === "orphan_authorisation";
}

export type ClassifyPaymentHoldAttentionArgs = {
  sessionStatus: string | null;
  tripStatus: string | null;
  paymentHoldStatus: string | null;
  releasedAt: string | null;
  capturedAt: string | null;
  capturedAmountPence?: number | null;
  feeStatus?: string | null;
  tripId: string | null;
  ageMinutes: number;
  releaseFailureReason: string | null;
  holdReleaseState?: string | null;
  holdTerminalReason?: string | null;
  providerOrderState?: string | null;
  orphanReversalStatus?: string | null;
  companionSessionReleased?: boolean;
  purposeLegacy?: boolean;
  recoveryAttemptCount?: number;
};

export function classifyPaymentHoldAttention(args: ClassifyPaymentHoldAttentionArgs): {
  attention_class: PaymentHoldAttentionClass;
  classification: PaymentHoldClassification;
  in_active_queue: boolean;
} {
  const provider = mapRevolutProviderHoldState(args.providerOrderState);
  const sessionCanonical = fromDbSessionStatus(args.sessionStatus);
  const tripStatus = String(args.tripStatus ?? "").toLowerCase();
  const holdStatus = String(args.paymentHoldStatus ?? "").toLowerCase();
  const recoveryAttempts = args.recoveryAttemptCount ?? 0;

  if (args.purposeLegacy) {
    return {
      attention_class: "LEGACY_EVIDENCE",
      classification: "GREEN",
      in_active_queue: false,
    };
  }

  // Companion orphan while session already released — evidence only.
  if (args.companionSessionReleased) {
    return {
      attention_class: "RESOLVED_COMPANION_SESSION",
      classification: "GREEN",
      in_active_queue: false,
    };
  }

  if (provider === "CANCELLED" || args.holdTerminalReason === "PROVIDER_CANCELLED") {
    return {
      attention_class: "RESOLVED_PROVIDER_CANCELLED",
      classification: "GREEN",
      in_active_queue: false,
    };
  }
  if (provider === "REVERTED" || args.holdTerminalReason === "PROVIDER_REVERTED") {
    return {
      attention_class: "RESOLVED_PROVIDER_REVERTED",
      classification: "GREEN",
      in_active_queue: false,
    };
  }
  if (
    provider === "CAPTURED"
    || args.capturedAt
    || sessionCanonical === "captured"
    || holdStatus === "captured"
  ) {
    const amountMissing = args.capturedAmountPence == null;
    const feePending = String(args.feeStatus ?? "").toUpperCase() === "PENDING"
      || (args.feeStatus == null && !amountMissing);
    // Provider-confirmed capture with missing amount must never be fully GREEN.
    if (amountMissing) {
      return {
        attention_class: "CAPTURED",
        classification: "AMBER",
        in_active_queue: false,
      };
    }
    if (feePending) {
      return {
        attention_class: "CAPTURED",
        classification: "AMBER",
        in_active_queue: false,
      };
    }
    return {
      attention_class: "CAPTURED",
      classification: "GREEN",
      in_active_queue: false,
    };
  }
  if (provider === "REFUNDED") {
    return {
      attention_class: "REFUNDED",
      classification: "GREEN",
      in_active_queue: false,
    };
  }
  if (args.releasedAt || sessionCanonical === "released" || holdStatus === "released"
    || args.holdReleaseState === "released") {
    return {
      attention_class: args.holdTerminalReason === "PROVIDER_REVERTED"
        ? "RESOLVED_PROVIDER_REVERTED"
        : "RESOLVED_PROVIDER_CANCELLED",
      classification: "GREEN",
      in_active_queue: false,
    };
  }

  if (args.releaseFailureReason || args.holdReleaseState === "release_failed") {
    return {
      attention_class: "RELEASE_FAILED",
      classification: "RED",
      in_active_queue: true,
    };
  }
  if (args.holdReleaseState === "release_pending") {
    return {
      attention_class: "RELEASE_PENDING",
      classification: "AMBER",
      in_active_queue: true,
    };
  }

  if (args.tripId && !TERMINAL_TRIP.has(tripStatus) && isAuthorisedSession(args.sessionStatus)) {
    return {
      attention_class: "OK_ACTIVE_TRIP",
      classification: "GREEN",
      in_active_queue: false,
    };
  }

  const providerActive =
    provider === "ACTIVE_AUTHORISED"
    || provider === "PENDING"
    || provider === "PROCESSING";

  if (
    (!args.tripId && isAuthorisedSession(args.sessionStatus))
    || providerActive
    || sessionCanonical === "orphan_authorisation"
  ) {
    const attention_class: PaymentHoldAttentionClass =
      !args.tripId && args.ageMinutes >= 0.5 && recoveryAttempts < 1
        ? "RECOVERY_PENDING"
        : "ACTIVE_AUTHORISED_HOLD";
    return {
      attention_class,
      classification: args.ageMinutes > 2 ? "RED" : "AMBER",
      in_active_queue: true,
    };
  }

  if (
    args.tripId
    && TERMINAL_TRIP.has(tripStatus)
    && (holdStatus === "authorised_hold" || isAuthorisedSession(args.sessionStatus) || providerActive)
  ) {
    return {
      attention_class: "ACTIVE_AUTHORISED_HOLD",
      classification: args.ageMinutes > 2 ? "RED" : "AMBER",
      in_active_queue: true,
    };
  }

  if (provider === "UNKNOWN" && args.providerOrderState) {
    return {
      attention_class: "UNKNOWN_PROVIDER_STATE",
      classification: "RED",
      in_active_queue: true,
    };
  }

  return {
    attention_class: "UNKNOWN_PROVIDER_STATE",
    classification: "RED",
    in_active_queue: true,
  };
}

export function moneyAtRiskInclude(args: {
  attentionClass: PaymentHoldAttentionClass;
  providerState?: CanonicalProviderHoldState | null;
  amountPence: number | null;
}): boolean {
  if (!ACTIVE_ATTENTION_CLASSES.has(args.attentionClass)) return false;
  if (args.attentionClass === "RELEASE_FAILED") {
    // Only if provider still confirms hold exists
    if (
      args.providerState
      && args.providerState !== "ACTIVE_AUTHORISED"
      && args.providerState !== "PENDING"
      && args.providerState !== "PROCESSING"
      && args.providerState !== "UNKNOWN"
    ) {
      return false;
    }
  }
  if (args.amountPence == null || !Number.isFinite(args.amountPence) || args.amountPence <= 0) {
    return false;
  }
  return true;
}

export type MoneyAtRiskSummary = {
  active_hold_count: number;
  active_hold_amount_pence: number;
  resolved_count: number;
  resolved_amount_pence: number;
  unknown_count: number;
};

export function summariseMoneyAtRisk(
  rows: Array<{
    attention_class: PaymentHoldAttentionClass;
    provider_state?: CanonicalProviderHoldState | null;
    amount_pence: number | null;
    in_active_queue: boolean;
  }>,
): MoneyAtRiskSummary {
  let active_hold_count = 0;
  let active_hold_amount_pence = 0;
  let resolved_count = 0;
  let resolved_amount_pence = 0;
  let unknown_count = 0;

  for (const row of rows) {
    if (moneyAtRiskInclude({
      attentionClass: row.attention_class,
      providerState: row.provider_state,
      amountPence: row.amount_pence,
    })) {
      active_hold_count += 1;
      active_hold_amount_pence += row.amount_pence ?? 0;
      continue;
    }
    if (row.attention_class === "UNKNOWN_PROVIDER_STATE" && row.in_active_queue) {
      unknown_count += 1;
      continue;
    }
    if (!row.in_active_queue) {
      resolved_count += 1;
      if (row.amount_pence != null && row.amount_pence > 0) {
        resolved_amount_pence += row.amount_pence;
      }
    }
  }

  return {
    active_hold_count,
    active_hold_amount_pence,
    resolved_count,
    resolved_amount_pence,
    unknown_count,
  };
}

/** Stable identity key for one logical hold. */
export function holdIdentityKey(
  paymentProvider: string | null | undefined,
  providerOrderId: string | null | undefined,
): string | null {
  const provider = String(paymentProvider ?? "").trim().toLowerCase();
  const orderId = String(providerOrderId ?? "").trim();
  if (!provider || !orderId) return null;
  return `${provider}:${orderId}`;
}
