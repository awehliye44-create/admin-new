/**
 * Payment Sessions — provider-confirmed residual release evidence (Slice 1).
 * Expected release may be computed for audit; stored amount requires provider evidence.
 */

export const RELEASE_EVIDENCE_STATUS = {
  NOT_REQUIRED: "NOT_REQUIRED",
  PENDING_PROVIDER_CONFIRMATION: "PENDING_PROVIDER_CONFIRMATION",
  CONFIRMED: "CONFIRMED",
  AMOUNT_UNCONFIRMED: "AMOUNT_UNCONFIRMED",
  FAILED: "FAILED",
  PROVIDER_STATE_UNAVAILABLE: "PROVIDER_STATE_UNAVAILABLE",
} as const;

export type ReleaseEvidenceStatus =
  typeof RELEASE_EVIDENCE_STATUS[keyof typeof RELEASE_EVIDENCE_STATUS];

export const RELEASE_EVIDENCE_SOURCE = {
  REVOLUT_POST_CAPTURE_RETRIEVE: "revolut_post_capture_retrieve",
  REVOLUT_ALREADY_CAPTURED_RECONCILE: "revolut_already_captured_reconcile",
  REVOLUT_WEBHOOK: "revolut_webhook",
  ADMIN_REFRESH: "admin_refresh",
} as const;

export type ReleaseEvidenceSource =
  typeof RELEASE_EVIDENCE_SOURCE[keyof typeof RELEASE_EVIDENCE_SOURCE]
  | string;

/** Audit expectation only — never write as confirmed release without provider proof. */
export function expectedReleasePence(args: {
  totalAuthorisedPence: number | null | undefined;
  capturedPence: number | null | undefined;
}): number {
  const auth = Math.max(0, Math.round(Number(args.totalAuthorisedPence ?? 0)));
  const cap = Math.max(0, Math.round(Number(args.capturedPence ?? 0)));
  return Math.max(0, auth - cap);
}

export function extractOutstandingAuthorisationPence(
  providerPayload: Record<string, unknown> | null | undefined,
): number | null {
  if (!providerPayload) return null;
  const candidates = [
    providerPayload.outstanding_amount,
    providerPayload.amount_outstanding,
    providerPayload.remaining_amount,
    providerPayload.authorised_amount_remaining,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === "object" && c !== null && "value" in (c as object)) {
      const n = Number((c as { value?: unknown }).value);
      if (Number.isFinite(n) && n >= 0) return Math.round(n);
      continue;
    }
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  return null;
}

/**
 * Classify residual release after a capture attempt.
 * Never sets released_amount_pence from authorised − captured alone.
 */
export function classifyPostCaptureResidualReleaseEvidence(args: {
  authorisedHoldPence: number;
  capturedAmountPence: number;
  providerPayload: Record<string, unknown> | null | undefined;
  retrieveSucceeded: boolean;
  /** Provider-explicit cancelled/released amount when present. */
  confirmedReleaseAmountPence?: number | null;
}): {
  release_evidence_status: ReleaseEvidenceStatus;
  released_amount_pence: number | null;
  expected_release_pence: number;
  set_released_at: boolean;
  hold_release_state: "released" | "release_pending" | "release_failed" | null;
  provider_state: string | null;
  residual_actively_held: boolean;
  reason: string;
} {
  const authorised = Math.max(0, Math.round(Number(args.authorisedHoldPence ?? 0)));
  const captured = Math.max(0, Math.round(Number(args.capturedAmountPence ?? 0)));
  const expected = expectedReleasePence({
    totalAuthorisedPence: authorised,
    capturedPence: captured,
  });

  if (expected === 0) {
    return {
      release_evidence_status: RELEASE_EVIDENCE_STATUS.NOT_REQUIRED,
      released_amount_pence: null,
      expected_release_pence: 0,
      set_released_at: false,
      hold_release_state: null,
      provider_state: args.providerPayload
        ? String(args.providerPayload.state ?? "").toUpperCase() || null
        : null,
      residual_actively_held: false,
      reason: "full_capture_no_residual",
    };
  }

  if (!args.retrieveSucceeded || !args.providerPayload) {
    return {
      release_evidence_status: RELEASE_EVIDENCE_STATUS.PROVIDER_STATE_UNAVAILABLE,
      released_amount_pence: null,
      expected_release_pence: expected,
      set_released_at: false,
      hold_release_state: "release_pending",
      provider_state: null,
      residual_actively_held: true,
      reason: "provider_retrieve_failed_or_empty",
    };
  }

  const payload = args.providerPayload;
  const providerState = String(payload.state ?? "").trim().toUpperCase() || null;
  const explicit =
    args.confirmedReleaseAmountPence != null
      && Number.isFinite(Number(args.confirmedReleaseAmountPence))
      && Number(args.confirmedReleaseAmountPence) > 0
      ? Math.round(Number(args.confirmedReleaseAmountPence))
      : null;
  const outstanding = extractOutstandingAuthorisationPence(payload);

  if (explicit != null) {
    return {
      release_evidence_status: RELEASE_EVIDENCE_STATUS.CONFIRMED,
      released_amount_pence: explicit,
      expected_release_pence: expected,
      set_released_at: true,
      hold_release_state: "released",
      provider_state: providerState,
      residual_actively_held: false,
      reason: "provider_explicit_release_amount",
    };
  }

  if (providerState === "FAILED") {
    return {
      release_evidence_status: RELEASE_EVIDENCE_STATUS.FAILED,
      released_amount_pence: null,
      expected_release_pence: expected,
      set_released_at: false,
      hold_release_state: "release_failed",
      provider_state: providerState,
      residual_actively_held: true,
      reason: "provider_failed_after_capture_attempt",
    };
  }

  if (providerState === "AUTHORISED" || providerState === "PROCESSING") {
    return {
      release_evidence_status: RELEASE_EVIDENCE_STATUS.PENDING_PROVIDER_CONFIRMATION,
      released_amount_pence: null,
      expected_release_pence: expected,
      set_released_at: false,
      hold_release_state: "release_pending",
      provider_state: providerState,
      residual_actively_held: true,
      reason: "authorisation_still_active",
    };
  }

  // Revolut: partial capture → COMPLETED; uncaptured remainder auto-voided.
  // Without explicit cancelled_amount, amount stays NULL (AMOUNT_UNCONFIRMED).
  if (providerState === "COMPLETED" || providerState === "CAPTURED") {
    if (outstanding != null && outstanding > 0) {
      return {
        release_evidence_status: RELEASE_EVIDENCE_STATUS.PENDING_PROVIDER_CONFIRMATION,
        released_amount_pence: null,
        expected_release_pence: expected,
        set_released_at: false,
        hold_release_state: "release_pending",
        provider_state: providerState,
        residual_actively_held: true,
        reason: "outstanding_authorisation_remains",
      };
    }
    return {
      release_evidence_status: RELEASE_EVIDENCE_STATUS.AMOUNT_UNCONFIRMED,
      released_amount_pence: null,
      expected_release_pence: expected,
      set_released_at: true,
      hold_release_state: "released",
      provider_state: providerState,
      residual_actively_held: false,
      reason: "terminal_capture_residual_voided_amount_unconfirmed",
    };
  }

  if (providerState === "CANCELLED" || providerState === "CANCELED" || providerState === "REVERTED") {
    return {
      release_evidence_status: RELEASE_EVIDENCE_STATUS.AMOUNT_UNCONFIRMED,
      released_amount_pence: null,
      expected_release_pence: expected,
      set_released_at: true,
      hold_release_state: "released",
      provider_state: providerState,
      residual_actively_held: false,
      reason: "provider_cancelled_or_reverted_amount_unconfirmed",
    };
  }

  return {
    release_evidence_status: RELEASE_EVIDENCE_STATUS.PENDING_PROVIDER_CONFIRMATION,
    released_amount_pence: null,
    expected_release_pence: expected,
    set_released_at: false,
    hold_release_state: "release_pending",
    provider_state: providerState,
    residual_actively_held: true,
    reason: "unrecognised_provider_state",
  };
}

/** Whether FR Missing Releases should treat this as an actionable missing release. */
export function isActionableMissingRelease(args: {
  release_evidence_status?: string | null;
  released_pence: number | null;
  expected_release_pence: number;
}): boolean {
  if (args.expected_release_pence <= 0) return false;
  const status = String(args.release_evidence_status ?? "").toUpperCase();
  if (
    status === RELEASE_EVIDENCE_STATUS.NOT_REQUIRED
    || status === RELEASE_EVIDENCE_STATUS.CONFIRMED
    || status === RELEASE_EVIDENCE_STATUS.AMOUNT_UNCONFIRMED
  ) {
    return false;
  }
  if (args.released_pence != null && args.released_pence >= 0) return false;
  return true;
}

export function buildResidualReleaseIdempotencyKey(args: {
  providerOrderId: string;
  capturedAmountPence: number;
  releaseEvidenceStatus: string;
}): string {
  return `residual_release:${args.providerOrderId}:${args.capturedAmountPence}:${args.releaseEvidenceStatus}`;
}

export function hasResidualReleaseIdempotencyKey(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  if (!metadata || !key) return false;
  const keys = Array.isArray(metadata.residual_release_idempotency_keys)
    ? (metadata.residual_release_idempotency_keys as string[])
    : [];
  return keys.includes(key);
}

/** Prefer not to downgrade a confirmed amount on replay. */
export function shouldSkipResidualReleasePersist(args: {
  existingEvidenceStatus?: string | null;
  existingReleasedAmountPence?: number | null;
  nextEvidenceStatus: ReleaseEvidenceStatus;
  nextReleasedAmountPence: number | null;
  idempotencyAlreadyApplied: boolean;
}): boolean {
  if (args.idempotencyAlreadyApplied) return true;
  const existing = String(args.existingEvidenceStatus ?? "").toUpperCase();
  if (
    existing === RELEASE_EVIDENCE_STATUS.CONFIRMED
    && args.existingReleasedAmountPence != null
    && args.existingReleasedAmountPence > 0
  ) {
    // Allow upgrade only if next is also CONFIRMED with same/positive amount; otherwise skip.
    if (args.nextEvidenceStatus !== RELEASE_EVIDENCE_STATUS.CONFIRMED) return true;
  }
  if (
    existing === RELEASE_EVIDENCE_STATUS.AMOUNT_UNCONFIRMED
    && args.nextEvidenceStatus === RELEASE_EVIDENCE_STATUS.PENDING_PROVIDER_CONFIRMATION
  ) {
    return true;
  }
  if (
    existing === RELEASE_EVIDENCE_STATUS.NOT_REQUIRED
    && args.nextEvidenceStatus !== RELEASE_EVIDENCE_STATUS.NOT_REQUIRED
  ) {
    // Full capture already marked — do not invent residual later without new capture.
    return args.nextEvidenceStatus === RELEASE_EVIDENCE_STATUS.PENDING_PROVIDER_CONFIRMATION;
  }
  return false;
}
