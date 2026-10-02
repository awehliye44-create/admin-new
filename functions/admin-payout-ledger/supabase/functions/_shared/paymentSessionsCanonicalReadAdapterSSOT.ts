/**
 * Payment Sessions Admin — canonical READ adapter (owned fields only).
 *
 * Ownership:
 * - Trip Fare SSOT stamps → final payable / expected capture target
 * - Settlement SSOT stamps → commissionable / commission / driver_net
 * - Payment Sessions → authorised / captured / released / refunded / fees
 * - FR → reconciliation conclusions when persisted (not reinvented here)
 *
 * This module READS stamps. It must not re-run computeCaptureAmount or
 * rebuild fare from additive modification fields.
 */

export type TripEconomicsStampInput = {
  final_fare_pence?: number | null;
  final_customer_fare_pence?: number | null;
  pickup_waiting_charge_pence?: number | null;
  stop_waiting_charge_pence?: number | null;
  stop_charge_total_pence?: number | null;
  total_waiting_charge_pence?: number | null;
  waiting_charge_pence?: number | null;
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
  no_show_charge_pence?: number | null;
  locked_base_fare_pence?: number | null;
  customer_modification_charge_pence?: number | null;
  destination_change_adjustment_pence?: number | null;
  discount_pence?: number | null;
  commissionable_fare_pence?: number | null;
  commission_pence?: number | null;
  platform_commission_amount?: number | null;
  driver_net_pence?: number | null;
  accepted_commission_percent?: number | null;
  driver_tier_commission_percent?: number | null;
  airport_charge_pence?: number | null;
  extras_pence?: number | null;
  other_pass_through_charges_pence?: number | null;
  refund_amount_pence?: number | null;
  accepted_preset_offer_fare_pence?: number | null;
  accepted_driver_offer_fare_pence?: number | null;
  locked_offer_type?: string | null;
  gross_fare_pence?: number | null;
};

export type CanonicalTripEconomicsRead = {
  /** Booking / locked ride base (audit). */
  original_locked_fare_pence: number | null;
  /** Preset quote when present (audit only — never used as final payable). */
  accepted_preset_offer_fare_pence: number | null;
  /** Negotiated / driver offer stamp when present (audit). */
  accepted_driver_offer_fare_pence: number | null;
  /** Ride-only customer payable (excludes waiting). */
  final_customer_payable_pence: number | null;
  /** Canonical trip fare including waiting (excludes tips). */
  final_fare_pence: number | null;
  pickup_waiting_pence: number | null;
  stop_waiting_pence: number | null;
  waiting_total_pence: number | null;
  /** Audit-only modification delta — never re-added to final payable. */
  modification_audit_pence: number | null;
  discount_pence: number | null;
  tip_pence: number | null;
  airport_pence: number | null;
  /**
   * Expected provider capture from Trip Fare stamps:
   * final_fare (+ tips) — never reconstructed via computeCaptureAmount.
   */
  expected_capture_pence: number | null;
  /** Settlement stamps. */
  commissionable_fare_pence: number | null;
  commission_percent: number | null;
  commission_pence: number | null;
  driver_net_pence: number | null;
  /**
   * FR does not yet persist per-session match_status for Payment Sessions chips/tabs.
   * Match/shortfall/overcapture on PS Admin are stamp↔provider interim only.
   */
  fr_match_status_persisted: false;
  match_classification_source: "stamp_vs_provider_interim";
};

function nonNeg(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

function nullablePence(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

export function resolvePickupWaitingPence(trip: TripEconomicsStampInput): number {
  return nonNeg(trip.pickup_waiting_charge_pence);
}

export function resolveStopWaitingPence(trip: TripEconomicsStampInput): number {
  return nonNeg(trip.stop_waiting_charge_pence) || nonNeg(trip.stop_charge_total_pence);
}

/**
 * Canonical final customer trip payable (Trip Fare stamp).
 * Prefer persisted final_fare_pence. Fallback: final_customer + waiting columns.
 * Never adds customer_modification_charge_pence when final_customer already exists.
 */
export function resolveCanonicalFinalPayablePence(
  trip: TripEconomicsStampInput,
): number | null {
  const stampedFinal = nullablePence(trip.final_fare_pence);
  if (stampedFinal != null && stampedFinal > 0) return stampedFinal;

  const ride = nullablePence(trip.final_customer_fare_pence) ?? 0;
  const waiting = resolvePickupWaitingPence(trip) + resolveStopWaitingPence(trip);
  const aggregateWaiting =
    waiting > 0
      ? waiting
      : nonNeg(trip.total_waiting_charge_pence) || nonNeg(trip.waiting_charge_pence);
  const total = ride + aggregateWaiting;
  return total > 0 ? total : null;
}

/**
 * Expected capture target for Admin compare chips/tabs.
 * = stamped final payable + tips (+ no-show when that is the charge).
 */
export function resolveCanonicalExpectedCapturePence(
  trip: TripEconomicsStampInput,
): number | null {
  const noShow = nonNeg(trip.no_show_charge_pence);
  const tips = nonNeg(trip.tip_pence ?? trip.tip_amount_pence);
  const payable = resolveCanonicalFinalPayablePence(trip);
  if (noShow > 0 && (payable == null || payable === 0)) {
    return noShow + tips;
  }
  if (payable == null) return tips > 0 ? tips : null;
  return payable + tips;
}

export function resolveSettlementCommissionPercent(
  trip: TripEconomicsStampInput,
): number | null {
  const accepted = trip.accepted_commission_percent;
  if (accepted != null && Number.isFinite(Number(accepted))) return Number(accepted);
  const tier = trip.driver_tier_commission_percent;
  if (tier != null && Number.isFinite(Number(tier))) return Number(tier);
  return null;
}

export function resolveSettlementCommissionPence(
  trip: TripEconomicsStampInput,
): number | null {
  const direct = nullablePence(trip.commission_pence);
  if (direct != null) return direct;
  return nullablePence(trip.platform_commission_amount);
}

/**
 * Build the canonical economics slice for Payment Sessions / Trip History reads.
 */
export function buildCanonicalTripEconomicsRead(
  trip: TripEconomicsStampInput,
): CanonicalTripEconomicsRead {
  const pickup = resolvePickupWaitingPence(trip);
  const stop = resolveStopWaitingPence(trip);
  const waitingTotal = pickup + stop;
  const finalCustomer = nullablePence(trip.final_customer_fare_pence);
  const finalFare = resolveCanonicalFinalPayablePence(trip);
  const modAudit =
    nonNeg(trip.customer_modification_charge_pence)
    || nonNeg(trip.destination_change_adjustment_pence);

  return {
    original_locked_fare_pence: nullablePence(trip.locked_base_fare_pence)
      ?? nullablePence(trip.accepted_preset_offer_fare_pence)
      ?? nullablePence(trip.accepted_driver_offer_fare_pence),
    accepted_preset_offer_fare_pence: nullablePence(trip.accepted_preset_offer_fare_pence),
    accepted_driver_offer_fare_pence: nullablePence(trip.accepted_driver_offer_fare_pence),
    final_customer_payable_pence: finalCustomer,
    final_fare_pence: finalFare,
    pickup_waiting_pence: pickup > 0 ? pickup : null,
    stop_waiting_pence: stop > 0 ? stop : null,
    waiting_total_pence: waitingTotal > 0 ? waitingTotal : null,
    modification_audit_pence: modAudit > 0 ? modAudit : null,
    discount_pence: nullablePence(trip.discount_pence),
    tip_pence: nullablePence(trip.tip_pence ?? trip.tip_amount_pence),
    airport_pence: nullablePence(trip.airport_charge_pence),
    expected_capture_pence: resolveCanonicalExpectedCapturePence(trip),
    commissionable_fare_pence: nullablePence(trip.commissionable_fare_pence),
    commission_percent: resolveSettlementCommissionPercent(trip),
    commission_pence: resolveSettlementCommissionPence(trip),
    driver_net_pence: nullablePence(trip.driver_net_pence),
    fr_match_status_persisted: false,
    match_classification_source: "stamp_vs_provider_interim",
  };
}

/**
 * Non-mod “other” components for display. Modification audit must not enter here
 * when final_customer already holds the folded payable (prevents 716+266+266).
 */
export function resolveOtherNonModComponentsPence(
  trip: TripEconomicsStampInput,
): number | null {
  const sum =
    nonNeg(trip.airport_charge_pence)
    + nonNeg(trip.extras_pence)
    + nonNeg(trip.other_pass_through_charges_pence)
    + nonNeg(trip.no_show_charge_pence);
  return sum > 0 ? sum : null;
}

export type StampCaptureCompare = {
  expected_capture_pence: number | null;
  provider_captured_pence: number | null;
  variance_pence: number | null;
  capture_classification:
    | "MATCHED"
    | "CAPTURE_SHORTFALL"
    | "UNEXPLAINED_OVERCAPTURE"
    | "CAPTURE_MISSING"
    | "TRIP_FARE_UNAVAILABLE"
    | "NO_PAYMENT_SESSION";
};

/**
 * Compare Trip Fare stamp expected vs Payment Sessions captured.
 * Interim Admin compare only — FR does not yet persist per-session match_status.
 */
export function compareStampExpectedVsProviderCapture(args: {
  expected_capture_pence: number | null;
  provider_captured_pence: number | null;
  has_payment_session: boolean;
}): StampCaptureCompare {
  if (!args.has_payment_session) {
    return {
      expected_capture_pence: args.expected_capture_pence,
      provider_captured_pence: args.provider_captured_pence,
      variance_pence: null,
      capture_classification: "NO_PAYMENT_SESSION",
    };
  }
  const expected = args.expected_capture_pence;
  const actual = args.provider_captured_pence;
  if (expected == null || expected <= 0) {
    return {
      expected_capture_pence: expected,
      provider_captured_pence: actual,
      variance_pence: null,
      capture_classification: "TRIP_FARE_UNAVAILABLE",
    };
  }
  if (actual == null) {
    return {
      expected_capture_pence: expected,
      provider_captured_pence: actual,
      variance_pence: null,
      capture_classification: "CAPTURE_MISSING",
    };
  }
  const variance = actual - expected;
  if (variance === 0) {
    return {
      expected_capture_pence: expected,
      provider_captured_pence: actual,
      variance_pence: 0,
      capture_classification: "MATCHED",
    };
  }
  if (variance < 0) {
    return {
      expected_capture_pence: expected,
      provider_captured_pence: actual,
      variance_pence: variance,
      capture_classification: "CAPTURE_SHORTFALL",
    };
  }
  return {
    expected_capture_pence: expected,
    provider_captured_pence: actual,
    variance_pence: variance,
    capture_classification: "UNEXPLAINED_OVERCAPTURE",
  };
}
