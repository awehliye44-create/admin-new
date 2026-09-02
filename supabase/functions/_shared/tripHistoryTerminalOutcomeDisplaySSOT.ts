/**
 * Trip History — read-only terminal fee outcome display (no-show / charged cancellation).
 *
 * Uses Payment Sessions capture evidence + terminalOutcomeEntitlementSSOT.
 * Never shows normal ride commission / driver net for terminal fee trips.
 */

import { isAdminNoShowTrip } from "./adminTripNoShowClassification.ts";
import {
  computeTerminalOutcomeEntitlement,
  type TerminalCaptureEvidence,
  type TerminalOutcomeKind,
} from "./terminalOutcomeEntitlementSSOT.ts";
import { resolveTerminalOutcomeKind, type TerminalTripRow } from "./terminalFeeSettlementResumptionSSOT.ts";

export type TripHistoryTerminalOutcomeTrip = TerminalTripRow & {
  capture_amount_pence?: number | null;
  provider_fee_pence?: number | null;
  commission_pence?: number | null;
  driver_net_pence?: number | null;
  commissionable_fare_pence?: number | null;
  locked_base_fare_pence?: number | null;
  accepted_preset_offer_fare_pence?: number | null;
  accepted_driver_offer_fare_pence?: number | null;
  estimated_fare?: number | null;
  gross_fare_pence?: number | null;
  final_fare_pence?: number | null;
  final_customer_fare_pence?: number | null;
  cancellation_reason?: string | null;
  terminal_disposition_reason?: string | null;
  payment_disposition?: {
    captured_amount_pence?: number | null;
    released_amount_pence?: number | null;
    refunded_amount_pence?: number | null;
    provider_processing_fee_pence?: number | null;
    fee_status?: string | null;
    provider_state?: string | null;
    payment_status?: string | null;
    payment_label?: string | null;
    amount_label?: string | null;
    amount_pence?: number | null;
    financial_model?: string | null;
    payment_session_id?: string | null;
    terminal_disposition_reason?: string | null;
    is_no_show_outcome?: boolean;
  } | null;
};

export type TripHistoryTerminalOutcomeDisplay = {
  outcome_kind: TerminalOutcomeKind;
  customer_charge_label: string;
  customer_charge_pence: number;
  provider_fee_pence: number | null;
  driver_entitlement_pence: number | null;
  onecab_commission_pence: number;
  entitlement_pending: boolean;
  entitlement_pending_message: string | null;
  original_quote_pence: number | null;
  hide_normal_settlement: boolean;
};

function positivePence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

function terminalReasonIsNoShow(trip: TripHistoryTerminalOutcomeTrip): boolean {
  const reason = String(
    trip.terminal_disposition_reason
      ?? trip.payment_disposition?.terminal_disposition_reason
      ?? trip.cancellation_reason
      ?? "",
  ).trim().toLowerCase().replace(/-/g, "_");
  return reason === "no_show" || reason.includes("customer_no_show");
}

export function resolveTripHistoryTerminalOutcomeKind(
  trip: TripHistoryTerminalOutcomeTrip | null | undefined,
): TerminalOutcomeKind | null {
  if (!trip) return null;
  const fromSsot = resolveTerminalOutcomeKind(trip);
  if (fromSsot) return fromSsot;

  if (isAdminNoShowTrip(trip) && (
    positivePence(trip.no_show_charge_pence) > 0
    || positivePence(trip.capture_amount_pence) > 0
    || terminalReasonIsNoShow(trip)
    || String(trip.status ?? "").toLowerCase() === "no_show"
    || String(trip.financial_outcome ?? "").toUpperCase() === "NO_SHOW"
  )) {
    return "NO_SHOW";
  }

  const cancelFee = positivePence(trip.cancellation_fee_pence);
  if (
    cancelFee > 0
    && (
      String(trip.financial_outcome ?? "").toUpperCase() === "LATE_PASSENGER_CANCELLATION"
      || positivePence(trip.capture_amount_pence) > 0
      || positivePence(trip.payment_disposition?.captured_amount_pence) > 0
    )
  ) {
    return "LATE_PASSENGER_CANCELLATION";
  }

  return null;
}

function resolveOriginalQuotePence(trip: TripHistoryTerminalOutcomeTrip): number | null {
  const candidates = [
    trip.accepted_preset_offer_fare_pence,
    trip.accepted_driver_offer_fare_pence,
    trip.locked_base_fare_pence,
    trip.gross_fare_pence,
    trip.final_fare_pence,
    trip.final_customer_fare_pence,
    trip.estimated_fare != null ? Math.round(Number(trip.estimated_fare) * 100) : null,
  ];
  let best = 0;
  for (const raw of candidates) {
    const n = positivePence(raw);
    if (n > best) best = n;
  }
  return best > 0 ? best : null;
}

function buildTerminalCaptureEvidence(
  trip: TripHistoryTerminalOutcomeTrip,
): TerminalCaptureEvidence {
  const disposition = trip.payment_disposition;
  const captured = Math.max(
    positivePence(disposition?.captured_amount_pence),
    positivePence(trip.capture_amount_pence),
    positivePence(trip.no_show_charge_pence),
    positivePence(trip.cancellation_fee_pence),
  );

  const sessionFeeStatus = String(disposition?.fee_status ?? "").toUpperCase();
  const sessionFee = disposition?.provider_processing_fee_pence;
  if (sessionFeeStatus === "ACTUAL" && sessionFee != null && Number.isFinite(Number(sessionFee))) {
    return {
      payment_session_id: disposition?.payment_session_id ?? null,
      captured_pence: captured,
      provider_fee_pence: Math.max(0, Math.round(Number(sessionFee))),
      provider_fee_confirmed: true,
    };
  }

  const tripFee = trip.provider_fee_pence;
  if (tripFee != null && Number.isFinite(Number(tripFee)) && Number(tripFee) >= 0) {
    return {
      payment_session_id: disposition?.payment_session_id ?? null,
      captured_pence: captured,
      provider_fee_pence: Math.max(0, Math.round(Number(tripFee))),
      provider_fee_confirmed: true,
    };
  }

  return {
    payment_session_id: disposition?.payment_session_id ?? null,
    captured_pence: captured,
    provider_fee_pence: sessionFee != null && Number.isFinite(Number(sessionFee))
      ? Math.max(0, Math.round(Number(sessionFee)))
      : null,
    provider_fee_confirmed: false,
  };
}

export function resolveTripHistoryTerminalOutcomeDisplay(
  trip: TripHistoryTerminalOutcomeTrip | null | undefined,
): TripHistoryTerminalOutcomeDisplay | null {
  const outcomeKind = resolveTripHistoryTerminalOutcomeKind(trip);
  if (!trip || !outcomeKind) return null;

  const evidence = buildTerminalCaptureEvidence(trip);
  const entitlement = computeTerminalOutcomeEntitlement(evidence);
  const customerCharge = entitlement.captured_pence > 0
    ? entitlement.captured_pence
    : Math.max(
      positivePence(trip.no_show_charge_pence),
      positivePence(trip.cancellation_fee_pence),
      positivePence(trip.capture_amount_pence),
    );

  const customerChargeLabel = outcomeKind === "NO_SHOW"
    ? (customerCharge > 0 ? "No-show fee captured" : "No-show — no charge")
    : (customerCharge > 0 ? "Cancellation fee charged" : "Cancellation — no charge");

  const originalQuote = resolveOriginalQuotePence(trip);
  const originalNotCharged = originalQuote != null && customerCharge > 0 && originalQuote > customerCharge
    ? originalQuote
    : originalQuote != null && customerCharge <= 0
      ? originalQuote
      : null;

  let pendingMessage: string | null = null;
  if (entitlement.pending || entitlement.expected_driver_entitlement_pence == null) {
    pendingMessage = entitlement.pending_reason === "missing_capture"
      ? "Driver entitlement pending verification — capture not confirmed"
      : "Driver entitlement pending verification — provider fee not confirmed";
  }

  return {
    outcome_kind: outcomeKind,
    customer_charge_label: customerChargeLabel,
    customer_charge_pence: customerCharge,
    provider_fee_pence: entitlement.provider_fee_confirmed ? entitlement.provider_fee_pence : null,
    driver_entitlement_pence: entitlement.expected_driver_entitlement_pence,
    onecab_commission_pence: 0,
    entitlement_pending: entitlement.pending || entitlement.expected_driver_entitlement_pence == null,
    entitlement_pending_message: pendingMessage,
    original_quote_pence: originalNotCharged,
    hide_normal_settlement: true,
  };
}
