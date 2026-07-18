/**
 * Payment Sessions — allowed actions from provider truth only.
 * Local flags (release_pending, incomplete, orphaned, STALE) never independently
 * enable Release hold / Retry recovery / Collect Outstanding.
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
  | "refund_difference";

export type PaymentSessionActionClassification =
  | "PROVIDER_REFRESH_REQUIRED"
  | "AUTHORISED_ACTIVE"
  | "CAPTURED_CONFIRMED"
  | "RELEASED_CONFIRMED"
  | "AUTHORISATION_EXPIRED"
  | "NO_ACTIVE_HOLD"
  | "RECOVERY_REQUIRED"
  | "RECOVERY_IN_PROGRESS"
  | "PROVIDER_ORDER_NOT_FOUND"
  | "DATA_BACKFILL_REQUIRED"
  | "RELEASE_PENDING"
  | "MANUAL_REVIEW_REQUIRED"
  | "OVERCAPTURED_REFUND_REQUIRED";

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
  local_state_corrected?: "LOCAL_STATE_CORRECTED_FROM_PROVIDER" | null;
  reject_reason_if_stale_action?: string | null;
};

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

function isNoActiveHold(canonical: CanonicalProviderHoldState | null): boolean {
  return (
    canonical === "CANCELLED"
    || canonical === "REVERTED"
    || canonical === "FAILED"
    || canonical === "REFUNDED"
  );
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
  recoveryAttemptCount?: number | null;
  recoveryAttemptRetryableFailed?: boolean | null;
  recoveryCurrentlyPendingOrCaptured?: boolean | null;
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
  ): PaymentSessionAllowedActionsResult => ({
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
    local_state_corrected: null,
    reject_reason_if_stale_action: null,
    ...extras,
  });

  if (orderNotFound) {
    return empty("PROVIDER_ORDER_NOT_FOUND", "PROVIDER ORDER NOT FOUND", {
      reject_reason_if_stale_action: "PROVIDER_ORDER_NOT_FOUND",
    });
  }

  if (retrieveFailed || verification === "UNAVAILABLE" || args.providerRetrieved === false) {
    return empty("PROVIDER_REFRESH_REQUIRED", "PROVIDER REFRESH REQUIRED", {
      provider_verified: false,
      reject_reason_if_stale_action: "PROVIDER_REFRESH_REQUIRED",
    });
  }

  // Without a successful provider retrieve on this reconcile pass, STALE/UNKNOWN
  // must not enable financial actions (may still show classification from last known).
  const providerFresh = providerRetrieved === true
    || verification === "VERIFIED";

  if (!providerFresh && verification !== "VERIFIED") {
    // Allow classification from last known provider state but no actions.
    const canonicalGuess = args.providerState
      ? mapRevolutProviderHoldState(args.providerState)
      : null;
    if (isValidConfirmedCapturePence(args.capturedPence) && (
      canonicalGuess === "CAPTURED" || args.capturedAt
    )) {
      return empty("CAPTURED_CONFIRMED", "CAPTURED — CONFIRMED", {
        provider_verified: false,
        captured_pence: confirmedPositiveCapturePence(args.capturedPence),
        reject_reason_if_stale_action: "PROVIDER_REFRESH_REQUIRED",
      });
    }
    return empty("PROVIDER_REFRESH_REQUIRED", "PROVIDER REFRESH REQUIRED", {
      provider_verified: false,
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
  const realReleasePending = localReleasePending
    && args.providerReleaseRequestSubmitted === true
    && Boolean(args.providerReleaseRequestId);

  // Provider confirms no active hold — clear false release-pending UX.
  if (isNoActiveHold(canonical) || (released != null && released > 0 && !isActiveAuthorisation(canonical) && captured == null)) {
    const corrected = localReleasePending && !realReleasePending
      ? "LOCAL_STATE_CORRECTED_FROM_PROVIDER" as const
      : null;
    if (canonical === "CANCELLED" || canonical === "REVERTED" || (released != null && released > 0 && captured == null)) {
      return empty("NO_ACTIVE_HOLD", "NO ACTIVE HOLD", {
        provider_canonical: canonical,
        authorised_pence: auth,
        released_pence: released,
        local_state_corrected: corrected,
        reject_reason_if_stale_action: "NO_ACTIVE_HOLD",
      });
    }
  }

  if (canonical === "CAPTURED" || (captured != null && !isActiveAuthorisation(canonical))) {
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
      const retryAllowed = args.recoveryAttemptRetryableFailed === true
        && args.recoveryCurrentlyPendingOrCaptured !== true
        && (args.recoveryAttemptCount ?? 0) >= 1;
      if (retryAllowed) actions.push("retry_recovery");

      return {
        classification: "RECOVERY_REQUIRED",
        classification_label: `RECOVERY REQUIRED · Outstanding £${(outstanding / 100).toFixed(2)}`,
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
        can_retry_recovery: actions.includes("retry_recovery"),
        can_refund: false,
        can_collect_outstanding: actions.includes("collect_outstanding"),
        can_send_payment_link: actions.includes("send_payment_link"),
        local_state_corrected: null,
        reject_reason_if_stale_action: "PAYMENT_ALREADY_CAPTURED",
      };
    }

    if (captureClass.classification === "OVERCAPTURED_REFUND_REQUIRED") {
      return {
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
        can_refund: true,
        can_collect_outstanding: false,
        can_send_payment_link: false,
        local_state_corrected: null,
        reject_reason_if_stale_action: "PAYMENT_ALREADY_CAPTURED",
      };
    }

    return empty("CAPTURED_CONFIRMED", "CAPTURED — CONFIRMED", {
      provider_canonical: canonical,
      captured_pence: captured,
      authorised_pence: auth,
      released_pence: released,
      outstanding_pence: outstanding,
      reject_reason_if_stale_action: "PAYMENT_ALREADY_CAPTURED",
    });
  }

  if (realReleasePending) {
    return empty("RELEASE_PENDING", "RELEASE PENDING", {
      provider_canonical: canonical,
      authorised_pence: auth,
      releasable_pence: releasable,
      reject_reason_if_stale_action: "RECOVERY_ALREADY_PENDING",
    });
  }

  // Local release_pending without provider request → not RELEASE_PENDING.
  if (localReleasePending && !realReleasePending && isActiveAuthorisation(canonical) && releasable > 0) {
    // Fall through to authorised active with correction flag.
  } else if (localReleasePending && !realReleasePending && !isActiveAuthorisation(canonical)) {
    return empty("NO_ACTIVE_HOLD", "NO ACTIVE HOLD", {
      provider_canonical: canonical,
      local_state_corrected: "LOCAL_STATE_CORRECTED_FROM_PROVIDER",
      reject_reason_if_stale_action: "NO_ACTIVE_HOLD",
    });
  }

  if (args.recoveryCurrentlyPendingOrCaptured === true && outstanding > 0) {
    return empty("RECOVERY_IN_PROGRESS", "RECOVERY IN PROGRESS", {
      outstanding_pence: outstanding,
      reject_reason_if_stale_action: "RECOVERY_ALREADY_PENDING",
    });
  }

  if (isActiveAuthorisation(canonical)) {
    const blockedByUnresolvedCharge = args.unresolvedFinalCharge === true;
    const blockedByInProgress = args.captureOrAuthInProgress === true;
    const canRelease = releasable > 0
      && !blockedByUnresolvedCharge
      && !blockedByInProgress
      && auth != null
      && auth > 0;

    if (canRelease) {
      return {
        classification: "AUTHORISED_ACTIVE",
        classification_label: `AUTHORISED ACTIVE · Releasable £${(releasable / 100).toFixed(2)}`,
        provider_verified: true,
        provider_verified_at: verifiedAt,
        provider_canonical: canonical,
        authorised_pence: auth,
        captured_pence: captured,
        released_pence: released,
        outstanding_pence: outstanding,
        releasable_pence: releasable,
        allowed_actions: ["release_hold"],
        can_release: true,
        can_retry_release: false,
        can_retry_recovery: false,
        can_refund: false,
        can_collect_outstanding: false,
        can_send_payment_link: false,
        local_state_corrected: localReleasePending && !realReleasePending
          ? "LOCAL_STATE_CORRECTED_FROM_PROVIDER"
          : null,
        reject_reason_if_stale_action: null,
      };
    }

    if (releasable <= 0 && (auth == null || auth === 0)) {
      return empty("AUTHORISATION_EXPIRED", "AUTHORISATION EXPIRED", {
        provider_canonical: canonical,
        reject_reason_if_stale_action: "NOTHING_TO_RELEASE",
      });
    }

    return empty("AUTHORISED_ACTIVE", "AUTHORISED ACTIVE", {
      provider_canonical: canonical,
      authorised_pence: auth,
      releasable_pence: releasable,
      reject_reason_if_stale_action: releasable <= 0 ? "NOTHING_TO_RELEASE" : null,
    });
  }

  if (canonical === "UNKNOWN" || !args.providerState) {
    if (auth == null && captured == null) {
      return empty("DATA_BACKFILL_REQUIRED", "DATA BACKFILL REQUIRED", {
        reject_reason_if_stale_action: "PROVIDER_REFRESH_REQUIRED",
      });
    }
    return empty("MANUAL_REVIEW_REQUIRED", "MANUAL REVIEW REQUIRED", {
      reject_reason_if_stale_action: "PROVIDER_STATE_CHANGED",
    });
  }

  return empty("NO_ACTIVE_HOLD", "NO ACTIVE HOLD", {
    provider_canonical: canonical,
    reject_reason_if_stale_action: "NO_ACTIVE_HOLD",
  });
}

/** Map UI/edge action names onto allowed_actions ids. */
export function holdActionToAllowedActionId(
  action: "release" | "retry_release" | "retry_recovery" | "refund" | "collect_outstanding" | "send_payment_link",
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
    default:
      return null;
  }
}

export function assertActionAllowed(
  allowed: PaymentSessionAllowedActionsResult,
  action: "release" | "retry_release" | "retry_recovery" | "refund" | "collect_outstanding" | "send_payment_link",
): { ok: true } | { ok: false; error_code: string; message: string } {
  const id = holdActionToAllowedActionId(action);
  if (!id || !allowed.allowed_actions.includes(id)) {
    return {
      ok: false,
      error_code: allowed.reject_reason_if_stale_action
        ?? (action === "release" || action === "retry_release"
          ? "NOTHING_TO_RELEASE"
          : action === "retry_recovery" || action === "collect_outstanding" || action === "send_payment_link"
          ? "NO_OUTSTANDING_BALANCE"
          : "PROVIDER_STATE_CHANGED"),
      message: `Action ${action} not permitted for classification ${allowed.classification}`,
    };
  }
  return { ok: true };
}
