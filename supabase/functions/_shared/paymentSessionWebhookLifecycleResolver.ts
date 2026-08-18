/**
 * Canonical monotonic Payment Session lifecycle resolver for Revolut webhooks.
 *
 * Webhook updates must never regress payment_sessions.status backwards.
 * Provider evidence (provider_state, captured_amount_pence) is separate from
 * application lifecycle status.
 *
 * Lock: paymentSessionWebhookLifecycleLock.test.ts
 */

import { fromDbPaymentSessionStatus } from "../../../shared/revolutPaymentHoldSSOT.ts";
import { revolutProviderStateRank } from "./revolutProviderStateRankSSOT.ts";

export type PaymentSessionWebhookLifecycleDecision =
  | "ADVANCE"
  | "KEEP_CURRENT"
  | "PENDING_EVIDENCE"
  | "LIFECYCLE_CONFLICT";

export type ResolvePaymentSessionStatusFromProviderWebhookInput = {
  currentStatus: string | null | undefined;
  providerState: string | null | undefined;
  tripId?: string | null | undefined;
  capturedAmountPence?: number | null | undefined;
  /** Authoritative stored captured amount on the session row. */
  storedCapturedAmountPence?: number | null | undefined;
  refundedAmountPence?: number | null | undefined;
  holdReleaseState?: string | null | undefined;
  financialOperationState?: string | null | undefined;
  financialModel?: string | null | undefined;
  purpose?: string | null | undefined;
  incomingProviderCaptureId?: string | null | undefined;
  storedProviderCaptureId?: string | null | undefined;
  storedProviderOrderId?: string | null | undefined;
  incomingProviderOrderId?: string | null | undefined;
  /** Provider state already persisted before this webhook (for stale-event guards). */
  priorProviderState?: string | null | undefined;
};

export type ResolvePaymentSessionStatusFromProviderWebhookResult = {
  decision: PaymentSessionWebhookLifecycleDecision;
  /** DB status value when decision is ADVANCE. */
  nextStatus?: string;
  reason: string;
};

const PROVIDER_CAPTURED = new Set(["COMPLETED", "CAPTURED"]);
const PROVIDER_AUTHORISED = new Set(["AUTHORISED", "AUTHORIZED"]);
const PROVIDER_TERMINAL_NEGATIVE = new Set(["CANCELLED", "CANCELED", "FAILED"]);
const PROVIDER_REFUNDED = new Set(["REFUNDED", "REVERSED"]);

/** Monotonic lifecycle rank — higher means later in the booking/capture lifecycle. */
export function paymentSessionStatusRank(status: string | null | undefined): number {
  const canonical = fromDbPaymentSessionStatus(status);
  switch (canonical) {
    case "created":
      return 10;
    case "checkout_open":
      return 20;
    case "authorising":
      return 25;
    case "authorised_hold":
      return 30;
    case "trip_created":
      return 40;
    case "dispatching":
      return 45;
    case "completed_pending_capture":
      return 48;
    case "captured":
    case "CAPTURE_CONFIRMED":
      return 50;
    case "released":
    case "failed":
    case "orphan_authorisation":
    case "cancelled":
    case "abandoned":
    case "expired":
      return 60;
    default: {
      const raw = String(status ?? "").trim().toLowerCase();
      if (raw.startsWith("recovery_")) return 55;
      if (raw === "refunded" || raw === "partially_refunded") return 65;
      return 0;
    }
  }
}

function normaliseProvider(state: string | null | undefined): string {
  return String(state ?? "").trim().toUpperCase();
}

function authoritativeCapturedAmountPence(
  input: ResolvePaymentSessionStatusFromProviderWebhookInput,
): number | null {
  const incoming = input.capturedAmountPence;
  if (typeof incoming === "number" && Number.isFinite(incoming) && incoming > 0) {
    return Math.round(incoming);
  }
  const stored = input.storedCapturedAmountPence;
  if (typeof stored === "number" && Number.isFinite(stored) && stored > 0) {
    return Math.round(stored);
  }
  return null;
}

function hasCaptureIdentityConflict(
  input: ResolvePaymentSessionStatusFromProviderWebhookInput,
): boolean {
  const incomingCapture = String(input.incomingProviderCaptureId ?? "").trim();
  const storedCapture = String(input.storedProviderCaptureId ?? "").trim();
  if (incomingCapture && storedCapture && incomingCapture !== storedCapture) {
    return true;
  }
  const incomingOrder = String(input.incomingProviderOrderId ?? "").trim();
  const storedOrder = String(input.storedProviderOrderId ?? "").trim();
  if (incomingOrder && storedOrder && incomingOrder !== storedOrder) {
    return true;
  }
  return false;
}

/**
 * Pure resolver — no I/O. Returns explicit lifecycle decision for webhook status.
 */
export function resolvePaymentSessionStatusFromProviderWebhook(
  input: ResolvePaymentSessionStatusFromProviderWebhookInput,
): ResolvePaymentSessionStatusFromProviderWebhookResult {
  const provider = normaliseProvider(input.providerState);
  const current = String(input.currentStatus ?? "");
  const currentRank = paymentSessionStatusRank(current);

  const financialModel = String(input.financialModel ?? "").toUpperCase();
  if (financialModel === "DRIVER_COLLECTED_COMMISSION_WALLET") {
    return {
      decision: "LIFECYCLE_CONFLICT",
      reason: "driver_collected_not_eligible_for_platform_webhook_lifecycle",
    };
  }

  const purpose = String(input.purpose ?? "").toUpperCase();
  if (purpose === "PAYMENT_RECOVERY") {
    return {
      decision: "LIFECYCLE_CONFLICT",
      reason: "payment_recovery_owned_by_recovery_path",
    };
  }

  if (hasCaptureIdentityConflict(input)) {
    return {
      decision: "LIFECYCLE_CONFLICT",
      reason: "conflicting_provider_capture_identity",
    };
  }

  const refunded = Number(input.refundedAmountPence ?? 0);
  if (Number.isFinite(refunded) && refunded > 0) {
    if (PROVIDER_CAPTURED.has(provider) || PROVIDER_AUTHORISED.has(provider)) {
      return {
        decision: "LIFECYCLE_CONFLICT",
        reason: "refunded_session_cannot_advance_to_capture_or_pre_capture",
      };
    }
    return { decision: "KEEP_CURRENT", reason: "refunded_state_preserved" };
  }

  if (PROVIDER_REFUNDED.has(provider)) {
    return { decision: "KEEP_CURRENT", reason: "refund_reversal_owned_elsewhere" };
  }

  if (PROVIDER_TERMINAL_NEGATIVE.has(provider)) {
    const priorProviderRank = revolutProviderStateRank(input.priorProviderState);
    if (priorProviderRank >= 40) {
      return {
        decision: "KEEP_CURRENT",
        reason: "late_terminal_negative_after_authorised_provider_state",
      };
    }
    if (currentRank >= 50) {
      return {
        decision: "LIFECYCLE_CONFLICT",
        reason: "cannot_apply_terminal_negative_after_capture",
      };
    }
    if (currentRank >= 60) {
      return { decision: "KEEP_CURRENT", reason: "already_terminal_negative" };
    }
    const nextStatus = provider === "FAILED" ? "failed" : "cancelled";
    if (current === nextStatus) {
      return { decision: "KEEP_CURRENT", reason: "terminal_negative_idempotent" };
    }
    return {
      decision: "ADVANCE",
      nextStatus,
      reason: "pre_capture_terminal_negative",
    };
  }

  if (PROVIDER_CAPTURED.has(provider)) {
    const capturedAmt = authoritativeCapturedAmountPence(input);
    if (capturedAmt == null) {
      return {
        decision: "PENDING_EVIDENCE",
        reason: "completed_without_authoritative_captured_amount",
      };
    }
    if (current === "captured") {
      return { decision: "KEEP_CURRENT", reason: "captured_idempotent" };
    }
    if (currentRank >= 60) {
      return {
        decision: "LIFECYCLE_CONFLICT",
        reason: "cannot_capture_from_terminal_negative_status",
      };
    }
    if (currentRank >= 50) {
      return { decision: "KEEP_CURRENT", reason: "already_at_or_beyond_captured" };
    }
    return {
      decision: "ADVANCE",
      nextStatus: "captured",
      reason: "verified_capture_evidence",
    };
  }

  if (PROVIDER_AUTHORISED.has(provider)) {
    if (currentRank >= 60) {
      return {
        decision: "LIFECYCLE_CONFLICT",
        reason: "authorised_webhook_after_terminal_negative",
      };
    }
    if (currentRank >= 50) {
      return {
        decision: "KEEP_CURRENT",
        reason: "authorised_webhook_after_capture_must_not_regress",
      };
    }
    const holdReleased = String(input.holdReleaseState ?? "").toLowerCase() === "released";
    if (holdReleased) {
      return {
        decision: "LIFECYCLE_CONFLICT",
        reason: "authorised_webhook_after_hold_released",
      };
    }
    const nextStatus = input.tripId ? "trip_created" : "payment_authorised";
    if (current === nextStatus) {
      return { decision: "KEEP_CURRENT", reason: "pre_capture_authorised_idempotent" };
    }
    const nextRank = paymentSessionStatusRank(nextStatus);
    if (currentRank > nextRank) {
      return {
        decision: "LIFECYCLE_CONFLICT",
        reason: "would_regress_pre_capture_status",
      };
    }
    return {
      decision: "ADVANCE",
      nextStatus,
      reason: "pre_capture_authorised",
    };
  }

  return { decision: "KEEP_CURRENT", reason: "unhandled_provider_state" };
}

/** Exported transition policy for audit reports and lock tests. */
export const PAYMENT_SESSION_WEBHOOK_TRANSITION_POLICY: ReadonlyArray<{
  from: string;
  to: string;
  allowed: boolean;
  condition: string;
}> = [
  { from: "trip_created", to: "captured", allowed: true, condition: "verified capture evidence present" },
  { from: "captured", to: "captured", allowed: true, condition: "idempotent duplicate webhook" },
  { from: "captured", to: "trip_created", allowed: false, condition: "forbidden regression" },
  { from: "captured", to: "payment_authorised", allowed: false, condition: "forbidden regression to pre-capture" },
  { from: "captured", to: "pending_payment", allowed: false, condition: "forbidden regression to pre-capture" },
  { from: "refunded", to: "trip_created", allowed: false, condition: "forbidden regression" },
  { from: "refunded", to: "captured", allowed: false, condition: "forbidden after refund" },
  { from: "cancelled", to: "trip_created", allowed: false, condition: "forbidden regression" },
  { from: "failed", to: "trip_created", allowed: false, condition: "forbidden regression" },
  { from: "released", to: "trip_created", allowed: false, condition: "forbidden regression" },
  { from: "released_after_recovery", to: "trip_created", allowed: false, condition: "forbidden regression" },
];
