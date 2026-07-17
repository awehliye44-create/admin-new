/**
 * Slice 9 — Historical customer-payment release evidence backfill (evidence only).
 * Never invents released_amount from authorised − captured.
 * Never touches driver wallets / payouts / Revolut Business /pay.
 */

import {
  RELEASE_EVIDENCE_STATUS,
  type ReleaseEvidenceStatus,
  classifyPostCaptureResidualReleaseEvidence,
  expectedReleasePence,
  extractProviderAuthorisedAmountPence,
  extractOutstandingAuthorisationPence,
} from "./paymentSessionReleaseEvidenceSSOT.ts";
import {
  extractConfirmedCaptureAmountPence,
  extractConfirmedReleaseAmountPence,
  extractProviderCaptureId,
} from "./paymentHoldProviderTerminalPure.ts";

export const HISTORICAL_RELEASE_EVIDENCE_BACKFILL = {
  SOURCE: "historical_release_evidence_backfill",
  VERSION: "slice9_v1",
} as const;

/**
 * Suggested status aliases → existing payment_sessions.release_evidence_status.
 * Do not invent new DB enum values; map at the audit boundary.
 */
export const RELEASE_EVIDENCE_STATUS_ALIAS = {
  VERIFIED_RELEASED: RELEASE_EVIDENCE_STATUS.CONFIRMED,
  VERIFIED_NO_RELEASE: RELEASE_EVIDENCE_STATUS.NOT_REQUIRED,
  PROVIDER_EVIDENCE_UNAVAILABLE: RELEASE_EVIDENCE_STATUS.PROVIDER_STATE_UNAVAILABLE,
  PROVIDER_PAYMENT_NOT_FOUND: RELEASE_EVIDENCE_STATUS.PROVIDER_STATE_UNAVAILABLE,
  AMBIGUOUS_PROVIDER_MATCH: RELEASE_EVIDENCE_STATUS.AMOUNT_UNCONFIRMED,
  NOT_APPLICABLE: RELEASE_EVIDENCE_STATUS.NOT_REQUIRED,
  MANUAL_REVIEW_REQUIRED: RELEASE_EVIDENCE_STATUS.AMOUNT_UNCONFIRMED,
} as const;

/** Strength order — never overwrite stronger verified with weaker. */
export const RELEASE_EVIDENCE_STRENGTH: Record<string, number> = {
  [RELEASE_EVIDENCE_STATUS.CONFIRMED]: 100,
  [RELEASE_EVIDENCE_STATUS.NOT_REQUIRED]: 90,
  [RELEASE_EVIDENCE_STATUS.AMOUNT_UNCONFIRMED]: 70,
  [RELEASE_EVIDENCE_STATUS.FAILED]: 50,
  [RELEASE_EVIDENCE_STATUS.PENDING_PROVIDER_CONFIRMATION]: 30,
  [RELEASE_EVIDENCE_STATUS.PROVIDER_STATE_UNAVAILABLE]: 10,
};

export function releaseEvidenceStrength(status: string | null | undefined): number {
  const key = String(status ?? "").toUpperCase();
  return RELEASE_EVIDENCE_STRENGTH[key] ?? 0;
}

export function wouldDowngradeReleaseEvidence(args: {
  existingStatus?: string | null;
  existingReleasedAmountPence?: number | null;
  nextStatus: ReleaseEvidenceStatus;
  nextReleasedAmountPence: number | null;
}): boolean {
  const existingStrength = releaseEvidenceStrength(args.existingStatus);
  const nextStrength = releaseEvidenceStrength(args.nextStatus);
  if (
    String(args.existingStatus ?? "").toUpperCase() === RELEASE_EVIDENCE_STATUS.CONFIRMED
    && args.existingReleasedAmountPence != null
    && args.existingReleasedAmountPence > 0
    && args.nextStatus !== RELEASE_EVIDENCE_STATUS.CONFIRMED
  ) {
    return true;
  }
  if (existingStrength > nextStrength) return true;
  return false;
}

export function buildHistoricalReleaseEvidenceIdempotencyKey(args: {
  sessionId: string;
  providerOrderId: string;
  capturedAmountPence: number;
  releaseEvidenceStatus: string;
  version?: string;
}): string {
  const version = args.version ?? HISTORICAL_RELEASE_EVIDENCE_BACKFILL.VERSION;
  return [
    "hist_rel_ev",
    version,
    args.sessionId,
    args.providerOrderId,
    String(Math.round(args.capturedAmountPence)),
    String(args.releaseEvidenceStatus).toUpperCase(),
  ].join(":");
}

export type EligibleHistoricalReleaseSession = {
  id: string;
  trip_id: string | null;
  provider_order_id: string | null;
  payment_provider?: string | null;
  authorised_amount_pence?: number | null;
  total_authorised_amount_pence?: number | null;
  captured_amount_pence?: number | null;
  released_amount_pence?: number | null;
  release_evidence_status?: string | null;
  status?: string | null;
};

/** Eligible: Revolut, has provider order id, captured/final, residual expected or evidence incomplete. */
export function isEligibleHistoricalReleaseEvidenceSession(
  row: EligibleHistoricalReleaseSession,
): { eligible: boolean; reason: string } {
  const provider = String(row.payment_provider ?? "revolut").toLowerCase();
  if (provider && provider !== "revolut") {
    return { eligible: false, reason: "not_revolut" };
  }
  const orderId = String(row.provider_order_id ?? "").trim();
  if (!orderId) return { eligible: false, reason: "missing_provider_order_id" };
  const captured = Math.round(Number(row.captured_amount_pence ?? 0));
  if (!(captured > 0)) return { eligible: false, reason: "no_authoritative_capture" };
  const auth = Math.round(Number(
    row.total_authorised_amount_pence ?? row.authorised_amount_pence ?? 0,
  ));
  if (!(auth > 0)) return { eligible: false, reason: "no_authorised_amount" };
  const expected = expectedReleasePence({
    totalAuthorisedPence: auth,
    capturedPence: captured,
  });
  const existingStatus = String(row.release_evidence_status ?? "").toUpperCase();
  const existingAmount = row.released_amount_pence == null
    ? null
    : Math.round(Number(row.released_amount_pence));
  if (
    existingStatus === RELEASE_EVIDENCE_STATUS.CONFIRMED
    && existingAmount != null
    && existingAmount > 0
  ) {
    return { eligible: false, reason: "already_has_confirmed_release_evidence" };
  }
  if (expected === 0 && existingStatus === RELEASE_EVIDENCE_STATUS.NOT_REQUIRED) {
    return { eligible: false, reason: "full_capture_already_not_required" };
  }
  // Residual expected with NULL amount, or evidence never verified.
  if (expected > 0 && existingAmount == null) {
    return { eligible: true, reason: "residual_amount_unconfirmed_or_missing" };
  }
  if (!existingStatus) {
    return { eligible: true, reason: "missing_release_evidence_status" };
  }
  return { eligible: false, reason: "no_backfill_needed" };
}

export function matchProviderAmountsToSession(args: {
  sessionAuthorisedPence: number;
  sessionCapturedPence: number;
  providerPayload: Record<string, unknown> | null | undefined;
}): {
  unambiguous: boolean;
  provider_authorised_pence: number | null;
  provider_captured_pence: number | null;
  provider_payment_id: string | null;
  reason: string;
} {
  const providerAuthorised = extractProviderAuthorisedAmountPence(args.providerPayload);
  const providerCaptured = extractConfirmedCaptureAmountPence(
    args.providerPayload,
    args.providerPayload ? String(args.providerPayload.state ?? "") : null,
  );
  const providerPaymentId = extractProviderCaptureId(args.providerPayload);
  if (providerAuthorised == null || providerCaptured == null) {
    return {
      unambiguous: false,
      provider_authorised_pence: providerAuthorised,
      provider_captured_pence: providerCaptured,
      provider_payment_id: providerPaymentId,
      reason: "provider_auth_or_capture_missing",
    };
  }
  if (providerAuthorised !== args.sessionAuthorisedPence) {
    return {
      unambiguous: false,
      provider_authorised_pence: providerAuthorised,
      provider_captured_pence: providerCaptured,
      provider_payment_id: providerPaymentId,
      reason: "authorised_mismatch",
    };
  }
  if (providerCaptured !== args.sessionCapturedPence) {
    return {
      unambiguous: false,
      provider_authorised_pence: providerAuthorised,
      provider_captured_pence: providerCaptured,
      provider_payment_id: providerPaymentId,
      reason: "captured_mismatch",
    };
  }
  return {
    unambiguous: true,
    provider_authorised_pence: providerAuthorised,
    provider_captured_pence: providerCaptured,
    provider_payment_id: providerPaymentId,
    reason: "matched",
  };
}

export type HistoricalReleaseEvidenceClassification = {
  release_evidence_status: ReleaseEvidenceStatus;
  released_amount_pence: number | null;
  expected_release_pence: number;
  unresolved_reason: string | null;
  provider_state: string | null;
  provider_payment_id: string | null;
  provider_authorised_pence: number | null;
  provider_captured_pence: number | null;
  provider_outstanding_pence: number | null;
  provider_explicit_release_pence: number | null;
  comparison_auth_minus_capture_pence: number;
  set_released_at: boolean;
  hold_release_state: "released" | "release_pending" | "release_failed" | null;
  match_unambiguous: boolean;
  suggested_alias: string;
};

export function classifyHistoricalReleaseEvidenceBackfill(args: {
  sessionAuthorisedPence: number;
  sessionCapturedPence: number;
  providerPayload: Record<string, unknown> | null | undefined;
  retrieveSucceeded: boolean;
  retrieveHttpStatus?: number | null;
}): HistoricalReleaseEvidenceClassification {
  const expected = expectedReleasePence({
    totalAuthorisedPence: args.sessionAuthorisedPence,
    capturedPence: args.sessionCapturedPence,
  });
  const comparison = expected;

  if (!args.retrieveSucceeded || !args.providerPayload) {
    const notFound = args.retrieveHttpStatus === 404;
    return {
      release_evidence_status: RELEASE_EVIDENCE_STATUS.PROVIDER_STATE_UNAVAILABLE,
      released_amount_pence: null,
      expected_release_pence: expected,
      unresolved_reason: notFound
        ? "provider_payment_not_found"
        : "provider_retrieve_failed_or_empty",
      provider_state: null,
      provider_payment_id: null,
      provider_authorised_pence: null,
      provider_captured_pence: null,
      provider_outstanding_pence: null,
      provider_explicit_release_pence: null,
      comparison_auth_minus_capture_pence: comparison,
      set_released_at: false,
      hold_release_state: "release_pending",
      match_unambiguous: false,
      suggested_alias: notFound
        ? "PROVIDER_PAYMENT_NOT_FOUND"
        : "PROVIDER_EVIDENCE_UNAVAILABLE",
    };
  }

  const match = matchProviderAmountsToSession({
    sessionAuthorisedPence: args.sessionAuthorisedPence,
    sessionCapturedPence: args.sessionCapturedPence,
    providerPayload: args.providerPayload,
  });
  const explicit = extractConfirmedReleaseAmountPence(args.providerPayload);
  const outstanding = extractOutstandingAuthorisationPence(args.providerPayload);

  if (!match.unambiguous) {
    return {
      release_evidence_status: RELEASE_EVIDENCE_STATUS.AMOUNT_UNCONFIRMED,
      released_amount_pence: null,
      expected_release_pence: expected,
      unresolved_reason: `ambiguous_provider_match:${match.reason}`,
      provider_state: String(args.providerPayload.state ?? "").toUpperCase() || null,
      provider_payment_id: match.provider_payment_id,
      provider_authorised_pence: match.provider_authorised_pence,
      provider_captured_pence: match.provider_captured_pence,
      provider_outstanding_pence: outstanding,
      provider_explicit_release_pence: explicit,
      comparison_auth_minus_capture_pence: comparison,
      set_released_at: false,
      hold_release_state: null,
      match_unambiguous: false,
      suggested_alias: "AMBIGUOUS_PROVIDER_MATCH",
    };
  }

  const classified = classifyPostCaptureResidualReleaseEvidence({
    authorisedHoldPence: args.sessionAuthorisedPence,
    capturedAmountPence: args.sessionCapturedPence,
    providerPayload: args.providerPayload,
    retrieveSucceeded: true,
    confirmedReleaseAmountPence: explicit,
  });

  let suggestedAlias = "MANUAL_REVIEW_REQUIRED";
  if (classified.release_evidence_status === RELEASE_EVIDENCE_STATUS.CONFIRMED) {
    suggestedAlias = "VERIFIED_RELEASED";
  } else if (classified.release_evidence_status === RELEASE_EVIDENCE_STATUS.NOT_REQUIRED) {
    suggestedAlias = "VERIFIED_NO_RELEASE";
  } else if (
    classified.release_evidence_status === RELEASE_EVIDENCE_STATUS.PROVIDER_STATE_UNAVAILABLE
  ) {
    suggestedAlias = "PROVIDER_EVIDENCE_UNAVAILABLE";
  } else if (
    classified.release_evidence_status === RELEASE_EVIDENCE_STATUS.AMOUNT_UNCONFIRMED
  ) {
    suggestedAlias = "MANUAL_REVIEW_REQUIRED";
  } else if (
    classified.release_evidence_status === RELEASE_EVIDENCE_STATUS.PENDING_PROVIDER_CONFIRMATION
  ) {
    suggestedAlias = "MANUAL_REVIEW_REQUIRED";
  }

  return {
    release_evidence_status: classified.release_evidence_status,
    released_amount_pence: classified.released_amount_pence,
    expected_release_pence: classified.expected_release_pence,
    unresolved_reason: classified.released_amount_pence == null
      && classified.release_evidence_status !== RELEASE_EVIDENCE_STATUS.NOT_REQUIRED
      ? classified.reason
      : null,
    provider_state: classified.provider_state,
    provider_payment_id: match.provider_payment_id,
    provider_authorised_pence: match.provider_authorised_pence,
    provider_captured_pence: match.provider_captured_pence,
    provider_outstanding_pence: outstanding,
    provider_explicit_release_pence: explicit,
    comparison_auth_minus_capture_pence: comparison,
    set_released_at: classified.set_released_at,
    hold_release_state: classified.hold_release_state,
    match_unambiguous: true,
    suggested_alias: suggestedAlias,
  };
}

export function buildProviderEvidenceSnapshot(
  order: Record<string, unknown> | null | undefined,
  retrievedAtIso: string,
): Record<string, unknown> | null {
  if (!order) return null;
  const payments = Array.isArray(order.payments) ? order.payments : [];
  const first = payments[0] && typeof payments[0] === "object"
    ? payments[0] as Record<string, unknown>
    : null;
  return {
    state: order.state ?? null,
    order_amount: order.order_amount ?? order.amount ?? null,
    order_outstanding_amount: order.order_outstanding_amount
      ?? order.outstanding_amount
      ?? null,
    cancelled_amount: order.cancelled_amount ?? order.canceled_amount ?? null,
    released_amount: order.released_amount ?? order.amount_released ?? null,
    payment_id: first?.id ?? null,
    payment_state: first?.state ?? null,
    payment_amount: first?.amount ?? null,
    payment_authorised_amount: first?.authorised_amount ?? first?.authorized_amount ?? null,
    verified_at: retrievedAtIso,
    source: HISTORICAL_RELEASE_EVIDENCE_BACKFILL.SOURCE,
    version: HISTORICAL_RELEASE_EVIDENCE_BACKFILL.VERSION,
  };
}
