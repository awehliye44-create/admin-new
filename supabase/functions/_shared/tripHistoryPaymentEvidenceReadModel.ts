/**
 * Trip History — unified read-only payment evidence for list, detail, and recapture.
 *
 * Single source for:
 * - discounted customer payable (never pre-promo gross as shortfall basis)
 * - verified captured (Payment Sessions → trip capture → legacy payments)
 * - outstanding shortfall (payable − net captured)
 * - recapture eligibility
 *
 * Must align with Payment status (read-only) / resolveTripHistoryPaymentLayers.
 */

import type { AdminTripPaymentDispositionRead } from "./adminTripPaymentDispositionSSOT.ts";
import {
  computeOutstandingShortfallPence,
  evaluateTripHistoryShortfallRecaptureEligibility,
  isVerifiedSettledCaptureSession,
  paymentCoverageBadgeLabel,
  type TripShortfallRecaptureUiState,
} from "./tripHistoryShortfallRecaptureSSOT.ts";
import {
  resolveTripHistoryPaymentLayers,
  type TripHistoryPaymentLayerPayment,
  type TripHistoryPaymentLayerSession,
  type TripHistoryPaymentLayerTrip,
} from "./tripHistoryPaymentLayersSSOT.ts";

export type TripHistoryPaymentEvidenceTrip = TripHistoryPaymentLayerTrip & {
  financial_model?: string | null;
  payment_method?: string | null;
  offer_discount_pence?: number | null;
  voucher_discount_pence?: number | null;
  discount_pence?: number | null;
  gross_fare_pence?: number | null;
  payment_disposition?: AdminTripPaymentDispositionRead | null;
};

export type BuildTripHistoryPaymentEvidenceArgs = {
  trip: TripHistoryPaymentEvidenceTrip;
  sessions?: TripHistoryPaymentLayerSession[] | null;
  payments?: TripHistoryPaymentLayerPayment[] | null;
  providerCapturedPence?: number | null;
  providerAuthorisedPence?: number | null;
  providerSettlementVerified?: boolean | null;
  paymentStatus?: string | null;
  providerStatus?: string | null;
  tripStatus?: string | null;
  adminPermitted?: boolean;
  hasOpenRecoveryAttempt?: boolean;
};

export type TripHistoryPaymentEvidenceReadModel = {
  customer_discounted_payable_pence: number;
  promotion_discount_pence: number;
  verified_captured_pence: number;
  net_verified_captured_pence: number;
  refunded_pence: number;
  outstanding_shortfall_pence: number;
  provider_settlement_verified: boolean;
  payable_source: string;
  evidence_source: string;
  coverage_label: string;
  coverage_tone: "fully_paid" | "partial" | "unpaid" | "unknown" | "canceled";
  recapture_eligible: boolean;
  recapture_ui_state: TripShortfallRecaptureUiState;
  recapture_reject_reason: string | null;
};

function positivePence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/** Reconstruct minimal session rows from list enrich disposition when full sessions are absent. */
export function sessionsFromTripPaymentDisposition(
  trip: TripHistoryPaymentEvidenceTrip,
): TripHistoryPaymentLayerSession[] {
  const disposition = trip.payment_disposition;
  if (!disposition) return [];
  const hasSession =
    disposition.payment_session_id != null
    || disposition.captured_amount_pence != null
    || disposition.released_amount_pence != null
    || disposition.refunded_amount_pence != null;
  if (!hasSession) return [];
  return [{
    status: disposition.payment_status,
    provider_state: disposition.provider_state,
    captured_amount_pence: disposition.captured_amount_pence,
    released_amount_pence: disposition.released_amount_pence,
    refunded_amount_pence: disposition.refunded_amount_pence,
  }];
}

export function resolveTripHistoryPromotionDiscountPence(
  trip: TripHistoryPaymentEvidenceTrip,
): number {
  const explicit = Math.max(
    positivePence(trip.offer_discount_pence),
    positivePence(trip.voucher_discount_pence),
    positivePence(trip.discount_pence),
  );
  if (explicit > 0) return explicit;

  const gross = Math.max(
    positivePence(trip.gross_fare_pence),
    positivePence(trip.final_fare_pence),
  );
  const discounted = positivePence(trip.final_customer_fare_pence);
  if (gross > discounted && discounted > 0) return gross - discounted;
  return 0;
}

function inferProviderSettlementVerified(args: {
  customerPayablePence: number;
  netCapturedPence: number;
  capturedPence: number;
  evidenceSource: string;
  paymentStatus?: string | null;
  providerStatus?: string | null;
  explicit?: boolean | null;
}): boolean {
  if (args.explicit === true) return true;
  if (args.capturedPence <= 0 || args.evidenceSource === "none") return false;
  const payable = args.customerPayablePence;
  if (payable > 0 && args.netCapturedPence >= payable - 1) {
    const blob = `${args.paymentStatus ?? ""} ${args.providerStatus ?? ""}`.toLowerCase();
    if (
      blob.includes("cancel")
      || blob.includes("fail")
      || blob.includes("void")
      || blob.includes("expired")
    ) {
      return false;
    }
    return true;
  }
  return isVerifiedSettledCaptureSession({
    status: args.paymentStatus,
    provider_state: args.providerStatus,
    captured_amount_pence: args.capturedPence,
  });
}

export function buildTripHistoryPaymentEvidenceReadModel(
  args: BuildTripHistoryPaymentEvidenceArgs,
): TripHistoryPaymentEvidenceReadModel {
  const sessions = args.sessions?.length
    ? args.sessions
    : sessionsFromTripPaymentDisposition(args.trip);

  const layers = resolveTripHistoryPaymentLayers({
    sessions,
    trip: args.trip,
    payments: args.payments ?? [],
    providerCapturedPence: args.providerCapturedPence,
    providerAuthorisedPence: args.providerAuthorisedPence,
  });

  const customer_discounted_payable_pence = layers.customer_payable_pence;
  const promotion_discount_pence = resolveTripHistoryPromotionDiscountPence(args.trip);
  const verified_captured_pence = layers.captured_pence;
  const refunded_pence = layers.refunded_pence;
  const net_verified_captured_pence = Math.max(0, verified_captured_pence - refunded_pence);

  const paymentStatus = args.paymentStatus
    ?? args.trip.payment_disposition?.payment_status
    ?? args.trip.payment_status;
  const providerStatus = args.providerStatus
    ?? args.trip.payment_disposition?.provider_state;

  const provider_settlement_verified = inferProviderSettlementVerified({
    customerPayablePence: customer_discounted_payable_pence,
    netCapturedPence: net_verified_captured_pence,
    capturedPence: verified_captured_pence,
    evidenceSource: layers.evidence_source,
    paymentStatus,
    providerStatus,
    explicit: args.providerSettlementVerified,
  });

  const outstanding_shortfall_pence = computeOutstandingShortfallPence({
    customerPayablePence: customer_discounted_payable_pence,
    verifiedCapturedTotalPence: verified_captured_pence,
    netRefundedTotalPence: refunded_pence,
  }) ?? 0;

  const coverage = paymentCoverageBadgeLabel({
    customerPayablePence: customer_discounted_payable_pence,
    verifiedCapturedTotalPence: verified_captured_pence,
    netRefundedTotalPence: refunded_pence,
    providerSettlementVerified: provider_settlement_verified,
    paymentStatus,
    providerStatus,
  });

  const recapture = evaluateTripHistoryShortfallRecaptureEligibility({
    tripStatus: args.tripStatus ?? args.trip.status,
    financialModel: args.trip.financial_model,
    paymentMethod: args.trip.payment_method,
    customerPayablePence: customer_discounted_payable_pence,
    verifiedCapturedTotalPence: verified_captured_pence,
    netRefundedTotalPence: refunded_pence,
    providerSettlementVerified: provider_settlement_verified,
    hasOpenRecoveryAttempt: args.hasOpenRecoveryAttempt,
    adminPermitted: args.adminPermitted,
  });

  return {
    customer_discounted_payable_pence,
    promotion_discount_pence,
    verified_captured_pence,
    net_verified_captured_pence,
    refunded_pence,
    outstanding_shortfall_pence,
    provider_settlement_verified,
    payable_source: layers.payable_source,
    evidence_source: layers.evidence_source,
    coverage_label: coverage.label,
    coverage_tone: coverage.tone,
    recapture_eligible: recapture.eligible,
    recapture_ui_state: recapture.ui_state,
    recapture_reject_reason: recapture.reject_reason,
  };
}
