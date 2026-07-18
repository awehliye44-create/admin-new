/**
 * Payment Sessions — allowed actions from provider truth only.
 * Local flags (release_pending, recovery_pending, incomplete, orphaned, STALE)
 * never independently enable Release hold / Retry recovery / Collect Outstanding.
 */

import {
  confirmedPositiveCapturePence,
  isValidConfirmedCapturePence,
} from "./paymentCaptureEvidenceSSOT.ts";
import {
  mapRevolutProviderHoldState,
  type CanonicalProviderHoldState,
} from "./paymentHoldClassificationSSOT.ts";
import {
  classifyCaptureConfirmation,
  computeOutstandingBalancePence,
  shouldOfferCollectOutstanding,
  shouldOfferSendPaymentLink,
} from "./paymentSessionsCaptureConfirmationSSOT.ts";

export type PaymentSessionActionId =
  | "release_hold"
  | "retry_release"
  | "retry_recovery"
  | "collect_outstanding"
  | "send_payment_link"
  | "refund_difference"
  | "capture_final_amount"
  | "refresh_provider_evidence";

export type PaymentSessionActionClassification =
  | "PROVIDER_REFRESH_REQUIRED"
  | "PROVIDER_STATE_UNCONFIRMED"
  | "AUTHORISED_ACTIVE"
  | "ACTIVE_AUTHORISATION"
  | "CAPTURED_CONFIRMED"
  | "CAPTURE_CONFIRMED"
  | "RELEASED_CONFIRMED"
  | "RELEASE_CONFIRMED"
  | "PROVIDER_ALREADY_RELEASED"
  | "AUTHORISATION_EXPIRED"
  | "NO_ACTIVE_HOLD"
  | "RECOVERY_REQUIRED"
  | "PAYMENT_RECOVERY_REQUIRED"
  | "OUTSTANDING_AMOUNT_REQUIRED"
  | "RECOVERY_IN_PROGRESS"
  | "PROVIDER_ORDER_NOT_FOUND"
  | "DATA_BACKFILL_REQUIRED"
  | "LOCAL_BACKFILL_REQUIRED"
  | "RECONCILIATION_REQUIRED"
  | "RELEASE_PENDING"
  | "MANUAL_REVIEW_REQUIRED"
  | "OVERCAPTURED_REFUND_REQUIRED";

export const PAYMENT_ACTION_STALE_REFRESH_REQUIRED =
  "PAYMENT_ACTION_STALE_REFRESH_REQUIRED" as const;

export type PaymentSessionAllowedActionsResult = {
  classification: PaymentSessionActionClassification;
  classification_label: string;
  provider_verified: boolean;
  provider_verified_at: string | null;
  provider_canonical: CanonicalProviderHoldState | null;
  authorised_pence: number | null;
  captured_pence: number | null;
  released_pence: number | null;
  outstanding_pence: number;
  releasable_pence: number;
  allowed_actions: PaymentSessionActionId[];
  can_release: boolean;
  can_retry_release: boolean;
  can_retry_recovery: boolean;
  can_refund: boolean;
  can_collect_outstanding: boolean;
  can_send_payment_link: boolean;
  can_capture_final: boolean;
  local_state_corrected?: "LOCAL_STATE_CORRECTED_FROM_PROVIDER" | null;
  reject_reason_if_stale_action?: string | null;
  /** Safe local projection repairs — never moves money. */
  projection_repairs?: PaymentSessionProjectionRepair[];
};

export type PaymentSessionProjectionRepair =
  | { field: "hold_release_state"; from: string | null; to: string | null; reason: string }
  | { field: "attention_class"; from: string | null; to: string | null; reason: string }
  | { field: "provider_state"; from: string | null; to: string | null; reason: string }
  | { field: "captured_amount_pence"; from: number | null; to: number | null; reason: string }
  | { field: "released_amount_pence"; from: number | null; to: number | null; reason: string };

function nonNeg(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * releasable_pence = provider_authorised - provider_captured - provider_released
 */
export function computeReleasablePence(args: {
  authorisedPence: number | null | undefined;
  capturedPence: number | null | undefined;
  releasedPence: number | null | undefined;
}): number {
  const auth = Math.max(0, nonNeg(args.authorisedPence) ?? 0);
  const cap = Math.max(0, confirmedPositiveCapturePence(args.capturedPence) ?? 0);
  const rel = Math.max(0, nonNeg(args.releasedPence) ?? 0);
  return Math.max(0, auth - cap - rel);
}

function isActiveAuthorisation(canonical: CanonicalProviderHoldState | null): boolean {
  return (
    canonical === "ACTIVE_AUTHORISED"
    || canonical === "PENDING"
    || canonical === "PROCESSING"
  );
}

function isReleasedOrCancelled(canonical: CanonicalProviderHoldState | null): boolean {
  return canonical === "CANCELLED" || canonical === "REVERTED";
}

function isNoActiveHold(canonical: CanonicalProviderHoldState | null): boolean {
  return (
    isReleasedOrCancelled(canonical)
    || canonical === "FAILED"
    || canonical === "REFUNDED"
  );
}

function withFlags(
  base: PaymentSessionAllowedActionsResult,
): PaymentSessionAllowedActionsResult {
  const actions = base.allowed_actions;
  return {
    ...base,
    can_release: actions.includes("release_hold"),
    can_retry_release: actions.includes("retry_release"),
    can_retry_recovery: actions.includes("retry_recovery"),
    can_refund: actions.includes("refund_difference"),
    can_collect_outstanding: actions.includes("collect_outstanding"),
    can_send_payment_link: actions.includes("send_payment_link"),
    can_capture_final: actions.includes("capture_final_amount"),
  };
}

/**
 * Plan safe local projection repairs from provider evidence.
 * Never moves money — only clears obsolete local flags / backfills amounts.
 */
export function planPaymentSessionLocalProjectionRepair(args: {
  providerState?: string | null;
  providerRetrieved?: boolean | null;
  authorisedPence?: number | null;
  capturedPence?: number | null;
  releasedPence?: number | null;
  localHoldReleaseState?: string | null;
  localAttentionClass?: string | null;
  providerReleaseRequestSubmitted?: boolean | null;
  providerReleaseRequestId?: string | null;
  outstandingPence?: number | null;
  localCapturedPence?: number | null;
  localReleasedPence?: number | null;
}): PaymentSessionProjectionRepair[] {
  const repairs: PaymentSessionProjectionRepair[] = [];
  if (args.providerRetrieved !== true) return repairs;

  const canonical = mapRevolutProviderHoldState(args.providerState);
  const localRelease = String(args.localHoldReleaseState ?? "").toLowerCase();
  const attention = String(args.localAttentionClass ?? "").toUpperCase();
  const outstanding = Math.max(0, nonNeg(args.outstandingPence) ?? 0);
  const realReleasePending = localRelease === "release_pending"
    && args.providerReleaseRequestSubmitted === true
    && Boolean(args.providerReleaseRequestId);

  if (
    (localRelease === "release_pending" || attention === "RELEASE_PENDING")
    && !realReleasePending
    && (isNoActiveHold(canonical) || canonical === "CAPTURED")
  ) {
    repairs.push({
      field: "hold_release_state",
      from: args.localHoldReleaseState ?? null,
      to: isReleasedOrCancelled(canonical) ? "released" : null,
      reason: "LOCAL_STATE_CORRECTED_FROM_PROVIDER",
    });
  }

  if (
    (attention === "RECOVERY_PENDING" || attention === "RELEASE_PENDING")
    && outstanding <= 0
    && !isActiveAuthorisation(canonical)
  ) {
    repairs.push({
      field: "attention_class",
      from: args.localAttentionClass ?? null,
      to: null,
      reason: "OBSOLETE_PENDING_CLEARED_NO_OUTSTANDING",
    });
  }

  const providerCaptured = confirmedPositiveCapturePence(args.capturedPence);
  const localCaptured = confirmedPositiveCapturePence(args.localCapturedPence);
  if (providerCaptured != null && localCaptured == null) {
    repairs.push({
      field: "captured_amount_pence",
      from: args.localCapturedPence ?? null,
      to: providerCaptured,
      reason: "BACKFILL_CAPTURED_FROM_PROVIDER",
    });
  }

  const providerReleased = nonNeg(args.releasedPence);
  const localReleased = nonNeg(args.localReleasedPence);
  if (
    (isReleasedOrCancelled(canonical) || (providerReleased != null && providerReleased > 0))
    && (localReleased == null || localReleased === 0)
    && providerReleased != null
    && providerReleased > 0
  ) {
    repairs.push({
      field: "released_amount_pence",
      from: args.localReleasedPence ?? null,
      to: providerReleased,
      reason: "BACKFILL_RELEASED_FROM_PROVIDER",
    });
  }

  return repairs;
}

/**
 * Derive allowed_actions strictly from provider evidence + canonical payable.
 * Local release_pending / recovery_pending / incomplete alone never enable actions.
 */
export function derivePaymentSessionAllowedActions(args: {
  providerOrderId?: string | null;
  providerState?: string | null;
  providerRetrieved?: boolean | null;
  providerRetrieveFailed?: boolean | null;
  providerOrderNotFound?: boolean | null;
  providerVerifiedAt?: string | null;
  providerVerificationStatus?: "VERIFIED" | "STALE" | "UNKNOWN" | "UNAVAILABLE" | null;
  authorisedPence?: number | null;
  capturedPence?: number | null;
  releasedPence?: number | null;
  releasedAt?: string | null;
  capturedAt?: string | null;
  canonicalPayablePence?: number | null;
  recoveryCapturedPence?: number | null;
  /** True only when a release request was submitted to Revolut with a request id. */
  providerReleaseRequestSubmitted?: boolean | null;
  providerReleaseRequestId?: string | null;
  /** Local hold_release_state — informational only; never sole enabler. */
  localHoldReleaseState?: string | null;
  /** Local attention — informational only; never sole enabler. */
  localAttentionClass?: string | null;
  recoveryAttemptCount?: number | null;
  recoveryAttemptRetryableFailed?: boolean | null;
  recoveryCurrentlyPendingOrCaptured?: boolean | null;
  /** Final fare / no-show / cancellation fee still needs capture from this hold. */
  unresolvedFinalCharge?: boolean | null;
  captureOrAuthInProgress?: boolean | null;
  purpose?: string | null;
  hasTrip?: boolean | null;
}): PaymentSessionAllowedActionsResult {
  const verifiedAt = args.providerVerifiedAt ?? null;
  const providerRetrieved = args.providerRetrieved === true;
  const retrieveFailed = args.providerRetrieveFailed === true;
  const orderNotFound = args.providerOrderNotFound === true
    || (!args.providerOrderId && providerRetrieved);
  const verification = String(args.providerVerificationStatus ?? "").toUpperCase();

  const empty = (
    classification: PaymentSessionActionClassification,
    label: string,
    extras?: Partial<PaymentSessionAllowedActionsResult>,
  ): PaymentSessionAllowedActionsResult => withFlags({
    classification,
    classification_label: label,
    provider_verified: providerRetrieved && !retrieveFailed && !orderNotFound,
    provider_verified_at: verifiedAt,
    provider_canonical: args.providerState
      ? mapRevolutProviderHoldState(args.providerState)
      : null,
    authorised_pence: nonNeg(args.authorisedPence),
    captured_pence: confirmedPositiveCapturePence(args.capturedPence),
    released_pence: nonNeg(args.releasedPence),
    outstanding_pence: 0,
    releasable_pence: 0,
    allowed_actions: [],
    can_release: false,
    can_retry_release: false,
    can_retry_recovery: false,
    can_refund: false,
    can_collect_outstanding: false,
    can_send_payment_link: false,
    can_capture_final: false,
    local_state_corrected: null,
    reject_reason_if_stale_action: PAYMENT_ACTION_STALE_REFRESH_REQUIRED,
    projection_repairs: [],
    ...extras,
  });

  if (orderNotFound) {
    return empty("PROVIDER_ORDER_NOT_FOUND", "PROVIDER ORDER NOT FOUND", {
      allowed_actions: ["refresh_provider_evidence"],
      reject_reason_if_stale_action: "PROVIDER_ORDER_NOT_FOUND",
    });
  }

  if (retrieveFailed || verification === "UNAVAILABLE" || args.providerRetrieved === false) {
    return empty("PROVIDER_REFRESH_REQUIRED", "PROVIDER REFRESH REQUIRED", {
      provider_verified: false,
      allowed_actions: ["refresh_provider_evidence"],
      reject_reason_if_stale_action: "PROVIDER_REFRESH_REQUIRED",
    });
  }

  const providerFresh = providerRetrieved === true || verification === "VERIFIED";

  if (!providerFresh && verification !== "VERIFIED") {
    const canonicalGuess = args.providerState
      ? mapRevolutProviderHoldState(args.providerState)
      : null;
    if (isValidConfirmedCapturePence(args.capturedPence) && (
      canonicalGuess === "CAPTURED" || args.capturedAt
    )) {
      return empty("CAPTURE_CONFIRMED", "CAPTURED — CONFIRMED ✅", {
        provider_verified: false,
        captured_pence: confirmedPositiveCapturePence(args.capturedPence),
        allowed_actions: ["refresh_provider_evidence"],
        reject_reason_if_stale_action: "PROVIDER_REFRESH_REQUIRED",
      });
    }
    return empty("PROVIDER_REFRESH_REQUIRED", "PROVIDER REFRESH REQUIRED", {
      provider_verified: false,
      allowed_actions: ["refresh_provider_evidence"],
      reject_reason_if_stale_action: "PROVIDER_REFRESH_REQUIRED",
    });
  }

  const canonical = mapRevolutProviderHoldState(args.providerState);
  const auth = nonNeg(args.authorisedPence);
  const captured = confirmedPositiveCapturePence(args.capturedPence);
  const released = nonNeg(args.releasedPence);
  const releasable = computeReleasablePence({
    authorisedPence: auth,
    capturedPence: captured,
    releasedPence: released,
  });

  const outstanding = computeOutstandingBalancePence({
    canonicalPayablePence: args.canonicalPayablePence,
    confirmedCapturePence: captured,
    confirmedRecoveryCapturePence: args.recoveryCapturedPence,
  }) ?? 0;

  const captureClass = classifyCaptureConfirmation({
    providerState: args.providerState,
    providerCapturedPence: captured,
    localCapturedPence: captured,
    canonicalPayablePence: args.canonicalPayablePence,
    authorisedPence: auth,
    releasedAmountPence: released,
    purpose: args.purpose,
  });

  const localReleasePending = String(args.localHoldReleaseState ?? "")
    .toLowerCase() === "release_pending";
  const localAttention = String(args.localAttentionClass ?? "").toUpperCase();
  const realReleasePending = localReleasePending
    && isActiveAuthorisation(canonical)
    && releasable > 0
    && args.providerReleaseRequestSubmitted === true
    && Boolean(args.providerReleaseRequestId);

  const projectionRepairs = planPaymentSessionLocalProjectionRepair({
    providerState: args.providerState,
    providerRetrieved: true,
    authorisedPence: auth,
    capturedPence: captured,
    releasedPence: released,
    localHoldReleaseState: args.localHoldReleaseState,
    localAttentionClass: args.localAttentionClass,
    providerReleaseRequestSubmitted: args.providerReleaseRequestSubmitted,
    providerReleaseRequestId: args.providerReleaseRequestId,
    outstandingPence: outstanding,
    localCapturedPence: captured,
    localReleasedPence: released,
  });

  const correctedFlag = projectionRepairs.some((r) =>
    r.reason === "LOCAL_STATE_CORRECTED_FROM_PROVIDER"
    || r.reason === "OBSOLETE_PENDING_CLEARED_NO_OUTSTANDING"
  )
    ? "LOCAL_STATE_CORRECTED_FROM_PROVIDER" as const
    : null;

  // A/B: Provider released / cancelled — never RELEASE_PENDING without active hold.
  if (isReleasedOrCancelled(canonical) || (released != null && released > 0 && !isActiveAuthorisation(canonical) && captured == null)) {
    return empty("RELEASED_CONFIRMED", "RELEASED — CONFIRMED ✅", {
      classification: "PROVIDER_ALREADY_RELEASED",
      classification_label: "RELEASED — CONFIRMED ✅",
      provider_canonical: canonical,
      authorised_pence: auth,
      released_pence: released,
      local_state_corrected: correctedFlag ?? (localReleasePending || localAttention === "RELEASE_PENDING"
        ? "LOCAL_STATE_CORRECTED_FROM_PROVIDER"
        : null),
      projection_repairs: projectionRepairs,
      reject_reason_if_stale_action: "NO_ACTIVE_HOLD",
    });
  }

  if (isNoActiveHold(canonical) && captured == null) {
    return empty("NO_ACTIVE_HOLD", "NO ACTIVE HOLD", {
      provider_canonical: canonical,
      authorised_pence: auth,
      released_pence: released,
      local_state_corrected: correctedFlag
        ?? ((localReleasePending || localAttention === "RELEASE_PENDING")
          ? "LOCAL_STATE_CORRECTED_FROM_PROVIDER"
          : null),
      projection_repairs: projectionRepairs,
      reject_reason_if_stale_action: "NO_ACTIVE_HOLD",
    });
  }

  // A: Provider captured / completed
  if (canonical === "CAPTURED" || (captured != null && !isActiveAuthorisation(canonical))) {
    // Local RECOVERY_PENDING with no outstanding → clear recovery actions.
    if (outstanding <= 0 && (localAttention === "RECOVERY_PENDING" || args.recoveryCurrentlyPendingOrCaptured)) {
      return empty("CAPTURE_CONFIRMED", "CAPTURED — CONFIRMED ✅", {
        provider_canonical: canonical,
        captured_pence: captured,
        authorised_pence: auth,
        released_pence: released,
        outstanding_pence: 0,
        local_state_corrected: "LOCAL_STATE_CORRECTED_FROM_PROVIDER",
        projection_repairs: projectionRepairs,
        reject_reason_if_stale_action: "NO_OUTSTANDING_BALANCE",
      });
    }

    if (captureClass.classification === "UNDERCAPTURED_RECOVERY_REQUIRED" && outstanding > 0) {
      const actions: PaymentSessionActionId[] = [];
      if (shouldOfferCollectOutstanding({
        classification: captureClass.classification,
        outstandingPence: outstanding,
      })) {
        actions.push("collect_outstanding");
      }
      if (shouldOfferSendPaymentLink({
        classification: captureClass.classification,
        outstandingPence: outstanding,
      })) {
        actions.push("send_payment_link");
      }
      // Retry only when a prior attempt exists AND is retryably failed — never from local RECOVERY_PENDING alone.
      const retryAllowed = outstanding > 0
        && args.recoveryAttemptRetryableFailed === true
        && args.recoveryCurrentlyPendingOrCaptured !== true
        && (args.recoveryAttemptCount ?? 0) >= 1;
      if (retryAllowed) actions.push("retry_recovery");

      return withFlags({
        classification: "OUTSTANDING_AMOUNT_REQUIRED",
        classification_label: `OUTSTANDING £${(outstanding / 100).toFixed(2)}`,
        provider_verified: true,
        provider_verified_at: verifiedAt,
        provider_canonical: canonical,
        authorised_pence: auth,
        captured_pence: captured,
        released_pence: released,
        outstanding_pence: outstanding,
        releasable_pence: 0,
        allowed_actions: actions,
        can_release: false,
        can_retry_release: false,
        can_retry_recovery: false,
        can_refund: false,
        can_collect_outstanding: false,
        can_send_payment_link: false,
        can_capture_final: false,
        local_state_corrected: null,
        projection_repairs: projectionRepairs,
        reject_reason_if_stale_action: "PAYMENT_ALREADY_CAPTURED",
      });
    }

    if (captureClass.classification === "OVERCAPTURED_REFUND_REQUIRED") {
      return withFlags({
        classification: "OVERCAPTURED_REFUND_REQUIRED",
        classification_label: captureClass.label,
        provider_verified: true,
        provider_verified_at: verifiedAt,
        provider_canonical: canonical,
        authorised_pence: auth,
        captured_pence: captured,
        released_pence: released,
        outstanding_pence: 0,
        releasable_pence: 0,
        allowed_actions: ["refund_difference"],
        can_release: false,
        can_retry_release: false,
        can_retry_recovery: false,
        can_refund: false,
        can_collect_outstanding: false,
        can_send_payment_link: false,
        can_capture_final: false,
        local_state_corrected: null,
        projection_repairs: projectionRepairs,
        reject_reason_if_stale_action: "PAYMENT_ALREADY_CAPTURED",
      });
    }

    return empty("CAPTURE_CONFIRMED", "CAPTURED — CONFIRMED ✅", {
      provider_canonical: canonical,
      captured_pence: captured,
      authorised_pence: auth,
      released_pence: released,
      outstanding_pence: outstanding,
      projection_repairs: projectionRepairs,
      reject_reason_if_stale_action: "PAYMENT_ALREADY_CAPTURED",
    });
  }

  // RELEASE_PENDING only with real provider release request + active hold.
  if (realReleasePending) {
    return empty("RELEASE_PENDING", "RELEASE PENDING", {
      provider_canonical: canonical,
      authorised_pence: auth,
      releasable_pence: releasable,
      projection_repairs: projectionRepairs,
      reject_reason_if_stale_action: "RECOVERY_ALREADY_PENDING",
    });
  }

  if (localReleasePending && !realReleasePending && !isActiveAuthorisation(canonical)) {
    return empty("NO_ACTIVE_HOLD", "NO ACTIVE HOLD", {
      provider_canonical: canonical,
      local_state_corrected: "LOCAL_STATE_CORRECTED_FROM_PROVIDER",
      projection_repairs: projectionRepairs,
      reject_reason_if_stale_action: "NO_ACTIVE_HOLD",
    });
  }

  if (args.recoveryCurrentlyPendingOrCaptured === true && outstanding > 0) {
    return empty("RECOVERY_IN_PROGRESS", "RECOVERY IN PROGRESS", {
      outstanding_pence: outstanding,
      projection_repairs: projectionRepairs,
      reject_reason_if_stale_action: "RECOVERY_ALREADY_PENDING",
    });
  }

  // C: Active authorisation
  if (isActiveAuthorisation(canonical)) {
    const blockedByUnresolvedCharge = args.unresolvedFinalCharge === true
      || (outstanding > 0 && (args.canonicalPayablePence ?? 0) > 0 && captured == null);
    const blockedByInProgress = args.captureOrAuthInProgress === true;

    // Fee / final fare due on active hold → capture only, never Release hold.
    if (blockedByUnresolvedCharge && !blockedByInProgress && releasable > 0) {
      return withFlags({
        classification: "ACTIVE_AUTHORISATION",
        classification_label: outstanding > 0
          ? `ACTIVE AUTHORISATION · Capture £${(outstanding / 100).toFixed(2)}`
          : "ACTIVE AUTHORISATION · Capture final amount",
        provider_verified: true,
        provider_verified_at: verifiedAt,
        provider_canonical: canonical,
        authorised_pence: auth,
        captured_pence: captured,
        released_pence: released,
        outstanding_pence: Math.max(outstanding, nonNeg(args.canonicalPayablePence) ?? 0),
        releasable_pence: releasable,
        allowed_actions: ["capture_final_amount"],
        can_release: false,
        can_retry_release: false,
        can_retry_recovery: false,
        can_refund: false,
        can_collect_outstanding: false,
        can_send_payment_link: false,
        can_capture_final: false,
        local_state_corrected: localReleasePending
          ? "LOCAL_STATE_CORRECTED_FROM_PROVIDER"
          : null,
        projection_repairs: projectionRepairs,
        reject_reason_if_stale_action: PAYMENT_ACTION_STALE_REFRESH_REQUIRED,
      });
    }

    const canRelease = releasable > 0
      && !blockedByUnresolvedCharge
      && !blockedByInProgress
      && auth != null
      && auth > 0;

    if (canRelease) {
      return withFlags({
        classification: "ACTIVE_AUTHORISATION",
        classification_label: `ACTIVE AUTHORISATION · Releasable £${(releasable / 100).toFixed(2)}`,
        provider_verified: true,
        provider_verified_at: verifiedAt,
        provider_canonical: canonical,
        authorised_pence: auth,
        captured_pence: captured,
        released_pence: released,
        outstanding_pence: outstanding,
        releasable_pence: releasable,
        allowed_actions: ["release_hold"],
        can_release: false,
        can_retry_release: false,
        can_retry_recovery: false,
        can_refund: false,
        can_collect_outstanding: false,
        can_send_payment_link: false,
        can_capture_final: false,
        local_state_corrected: localReleasePending && !realReleasePending
          ? "LOCAL_STATE_CORRECTED_FROM_PROVIDER"
          : null,
        projection_repairs: projectionRepairs,
        reject_reason_if_stale_action: null,
      });
    }

    if (releasable <= 0 && (auth == null || auth === 0)) {
      return empty("AUTHORISATION_EXPIRED", "AUTHORISATION EXPIRED", {
        provider_canonical: canonical,
        projection_repairs: projectionRepairs,
        reject_reason_if_stale_action: "NOTHING_TO_RELEASE",
      });
    }

    return empty("ACTIVE_AUTHORISATION", "ACTIVE AUTHORISATION", {
      provider_canonical: canonical,
      authorised_pence: auth,
      releasable_pence: releasable,
      projection_repairs: projectionRepairs,
      reject_reason_if_stale_action: releasable <= 0
        ? "NOTHING_TO_RELEASE"
        : PAYMENT_ACTION_STALE_REFRESH_REQUIRED,
    });
  }

  if (canonical === "UNKNOWN" || !args.providerState) {
    if (auth == null && captured == null) {
      return empty("LOCAL_BACKFILL_REQUIRED", "LOCAL BACKFILL REQUIRED", {
        allowed_actions: ["refresh_provider_evidence"],
        projection_repairs: projectionRepairs,
        reject_reason_if_stale_action: "PROVIDER_REFRESH_REQUIRED",
      });
    }
    return empty("PROVIDER_STATE_UNCONFIRMED", "PROVIDER STATE UNCONFIRMED", {
      allowed_actions: ["refresh_provider_evidence"],
      projection_repairs: projectionRepairs,
      reject_reason_if_stale_action: "PROVIDER_STATE_CHANGED",
    });
  }

  return empty("RECONCILIATION_REQUIRED", "RECONCILIATION REQUIRED", {
    provider_canonical: canonical,
    projection_repairs: projectionRepairs,
    allowed_actions: ["refresh_provider_evidence"],
    reject_reason_if_stale_action: PAYMENT_ACTION_STALE_REFRESH_REQUIRED,
  });
}

/** Map UI/edge action names onto allowed_actions ids. */
export function holdActionToAllowedActionId(
  action:
    | "release"
    | "retry_release"
    | "retry_recovery"
    | "refund"
    | "collect_outstanding"
    | "send_payment_link"
    | "capture_final_amount"
    | "refresh_provider_evidence",
): PaymentSessionActionId | null {
  switch (action) {
    case "release":
      return "release_hold";
    case "retry_release":
      return "retry_release";
    case "retry_recovery":
      return "retry_recovery";
    case "refund":
      return "refund_difference";
    case "collect_outstanding":
      return "collect_outstanding";
    case "send_payment_link":
      return "send_payment_link";
    case "capture_final_amount":
      return "capture_final_amount";
    case "refresh_provider_evidence":
      return "refresh_provider_evidence";
    default:
      return null;
  }
}

export function assertActionAllowed(
  allowed: PaymentSessionAllowedActionsResult,
  action:
    | "release"
    | "retry_release"
    | "retry_recovery"
    | "refund"
    | "collect_outstanding"
    | "send_payment_link"
    | "capture_final_amount"
    | "refresh_provider_evidence",
): { ok: true } | { ok: false; error_code: string; message: string } {
  const id = holdActionToAllowedActionId(action);
  if (!id || !allowed.allowed_actions.includes(id)) {
    const specific = allowed.reject_reason_if_stale_action;
    // Prefer explicit domain codes when set; otherwise stale-refresh for UI race.
    const error_code = specific
      && specific !== PAYMENT_ACTION_STALE_REFRESH_REQUIRED
      && (
        specific === "NO_ACTIVE_HOLD"
        || specific === "NOTHING_TO_RELEASE"
        || specific === "NO_OUTSTANDING_BALANCE"
        || specific === "RECOVERY_ALREADY_PENDING"
        || specific === "PAYMENT_ALREADY_CAPTURED"
        || specific === "PROVIDER_STATE_CHANGED"
        || specific === "PROVIDER_REFRESH_REQUIRED"
        || specific === "PROVIDER_ORDER_NOT_FOUND"
      )
      ? specific
      : PAYMENT_ACTION_STALE_REFRESH_REQUIRED;
    return {
      ok: false,
      error_code,
      message: `Action ${action} not permitted for classification ${allowed.classification}`,
    };
  }
  return { ok: true };
}
