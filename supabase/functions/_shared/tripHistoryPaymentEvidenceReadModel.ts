/**
 * Trip History — unified read-only payment evidence for list, detail, and recapture.
 *
 * Delegates payable/shortfall ownership to customerShortfallEvidenceSSOT
 * (never tip-double-count; never fold heuristics).
 */

import type { AdminTripPaymentDispositionRead } from "./adminTripPaymentDispositionSSOT.ts";
import {
  buildCustomerShortfallEvidence,
  CUSTOMER_PAYABLE_SOURCE,
  FARE_FIELD_CONTRACT,
} from "./customerShortfallEvidenceSSOT.ts";
import {
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
  airport_charge_pence?: number | null;
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
  /**
   * Tip-inclusive Edge payable already resolved once.
   * When set, used exactly once — never re-derived via final_* + tip.
   */
  customer_payable_pence?: number | null;
  /** @deprecated use customer_payable_pence */
  authoritativeCustomerPayablePence?: number | null;
  fare_field_contract?: typeof FARE_FIELD_CONTRACT[keyof typeof FARE_FIELD_CONTRACT] | null;
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
  evidence_complete: boolean;
  unavailable_reason: string | null;
  fare_component_pence: number | null;
  tip_component_pence: number | null;
  airport_component_pence: number | null;
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

  const explicitPayable = positivePence(
    args.customer_payable_pence ?? args.authoritativeCustomerPayablePence,
  );

  const shortfall = buildCustomerShortfallEvidence({
    final_customer_fare_pence: args.trip.final_customer_fare_pence,
    final_fare_pence: args.trip.final_fare_pence,
    locked_base_fare_pence: args.trip.locked_base_fare_pence,
    tip_pence: args.trip.tip_pence,
    tip_amount_pence: args.trip.tip_amount_pence,
    airport_charge_pence: args.trip.airport_charge_pence,
    no_show_charge_pence: args.trip.no_show_charge_pence,
    cancellation_fee_pence: args.trip.cancellation_fee_pence,
    payment_status: args.paymentStatus
      ?? args.trip.payment_disposition?.payment_status
      ?? args.trip.payment_status,
    financial_outcome: args.trip.financial_outcome,
    status: args.tripStatus ?? args.trip.status,
    financial_model: args.trip.financial_model,
    payment_method: args.trip.payment_method,
    capture_amount_pence: args.trip.capture_amount_pence,
    customer_payable_pence: explicitPayable > 0 ? explicitPayable : null,
    customer_payable_source: explicitPayable > 0
      ? CUSTOMER_PAYABLE_SOURCE.AUTHORITATIVE_CUSTOMER_PAYABLE
      : null,
    fare_field_contract: args.fare_field_contract
      ?? (explicitPayable > 0
        ? FARE_FIELD_CONTRACT.AUTHORITATIVE_AGGREGATE
        : FARE_FIELD_CONTRACT.TIP_EXCLUSIVE_FINAL),
    sessions,
    trip_capture_fallback_pence: args.trip.capture_amount_pence,
    providerSettlementVerified: args.providerSettlementVerified,
    hasOpenRecoveryAttempt: args.hasOpenRecoveryAttempt,
    adminPermitted: args.adminPermitted,
  });

  const customer_discounted_payable_pence =
    shortfall.authoritative_customer_payable_pence ?? 0;
  const promotion_discount_pence = resolveTripHistoryPromotionDiscountPence(args.trip);
  const verified_captured_pence = Math.max(
    shortfall.verified_captured_pence,
    layers.captured_pence,
  );
  const refunded_pence = Math.max(shortfall.verified_refunded_pence, layers.refunded_pence);
  const net_verified_captured_pence = Math.max(0, verified_captured_pence - refunded_pence);
  const outstanding_shortfall_pence = shortfall.outstanding_shortfall_pence ?? 0;

  const paymentStatus = args.paymentStatus
    ?? args.trip.payment_disposition?.payment_status
    ?? args.trip.payment_status;
  const providerStatus = args.providerStatus
    ?? args.trip.payment_disposition?.provider_state;

  const provider_settlement_verified = args.providerSettlementVerified === true
    || (verified_captured_pence > 0
      && outstanding_shortfall_pence === 0
      && shortfall.evidence_complete);

  const coverage = paymentCoverageBadgeLabel({
    customerPayablePence: customer_discounted_payable_pence,
    verifiedCapturedTotalPence: verified_captured_pence,
    netRefundedTotalPence: refunded_pence,
    providerSettlementVerified: provider_settlement_verified,
    paymentStatus,
    providerStatus,
  });

  return {
    customer_discounted_payable_pence,
    promotion_discount_pence,
    verified_captured_pence,
    net_verified_captured_pence,
    refunded_pence,
    outstanding_shortfall_pence,
    provider_settlement_verified,
    payable_source: shortfall.payable_source,
    evidence_source: layers.evidence_source,
    coverage_label: coverage.label,
    coverage_tone: coverage.tone,
    recapture_eligible: shortfall.recapture_eligible,
    recapture_ui_state: (shortfall.recapture_ui_state
      ?? (coverage.tone === "fully_paid" ? "fully_paid" : "not_eligible")) as TripShortfallRecaptureUiState,
    recapture_reject_reason: shortfall.reject_code,
    evidence_complete: shortfall.evidence_complete,
    unavailable_reason: shortfall.unavailable_reason,
    fare_component_pence: shortfall.fare_component_pence,
    tip_component_pence: shortfall.tip_component_pence,
    airport_component_pence: shortfall.airport_component_pence,
  };
}
