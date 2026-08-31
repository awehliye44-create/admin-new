/**
 * Trip History Payment status — unified 4 payment layers.
 *
 * Authorized / Captured / Refunded / Refundable must use the same money
 * evidence on every trip. Never invent capture from fare alone.
 *
 * Priority for Captured:
 *   1. Payment Sessions positive capture (non-failed)
 *   2. trips.capture_amount_pence
 *   3. legacy payments.captured_amount_pence sum
 *   4. live provider completed amount (caller-supplied)
 *
 * Customer payable includes no-show / cancellation / arrival fees when
 * final fare is absent (fee-only terminal trips).
 */

import { resolveCanonicalCustomerPayablePence } from "./paymentSessionsCaptureConfirmationSSOT.ts";
import {
  isVerifiedSettledCaptureSession,
  sumVerifiedCapturedFromSessions,
  sumVerifiedRefundedFromSessions,
} from "./tripHistoryShortfallRecaptureSSOT.ts";

export type TripHistoryPaymentLayerSession = {
  purpose?: string | null;
  status?: string | null;
  provider_state?: string | null;
  captured_amount_pence?: number | null;
  authorised_amount_pence?: number | null;
  total_authorised_amount_pence?: number | null;
  refunded_amount_pence?: number | null;
};

export type TripHistoryPaymentLayerTrip = {
  authorised_amount_pence?: number | null;
  capture_amount_pence?: number | null;
  refund_amount_pence?: number | null;
  final_fare_pence?: number | null;
  final_customer_fare_pence?: number | null;
  no_show_charge_pence?: number | null;
  cancellation_fee_pence?: number | null;
  arrival_cancellation_applied?: boolean | null;
  arrival_cancellation_fee?: number | null; // pounds (legacy trip column)
  arrival_cancellation_fee_pence?: number | null;
  outstanding_balance_pence?: number | null;
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
  payment_status?: string | null;
  provider_status?: string | null;
};

export type TripHistoryPaymentLayerPayment = {
  captured_amount_pence?: number | null;
  amount_pence?: number | null;
  status?: string | null;
};

export type TripHistoryPaymentLayers = {
  authorized_pence: number;
  captured_pence: number;
  refunded_pence: number;
  refundable_pence: number;
  customer_payable_pence: number;
  payable_source: string;
  evidence_source:
    | "payment_sessions"
    | "trip_capture"
    | "legacy_payments"
    | "provider_live"
    | "none";
  has_payment_evidence: boolean;
};

function positivePence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

function arrivalCancellationPence(trip: TripHistoryPaymentLayerTrip): number {
  if (trip.arrival_cancellation_fee_pence != null) {
    return positivePence(trip.arrival_cancellation_fee_pence);
  }
  if (trip.arrival_cancellation_applied === true && trip.arrival_cancellation_fee != null) {
    const pounds = Number(trip.arrival_cancellation_fee);
    if (Number.isFinite(pounds) && pounds > 0) return Math.round(pounds * 100);
  }
  return 0;
}

/** Positive capture on a non-failed session — Trip History display evidence. */
export function sumDisplayCapturedFromSessions(
  sessions: TripHistoryPaymentLayerSession[],
): number {
  const verified = sumVerifiedCapturedFromSessions(sessions).total_verified_captured_pence;
  if (verified > 0) return verified;

  // Fallback: any positive capture that is not terminal-failed (status quirks).
  let sum = 0;
  for (const s of sessions) {
    const amt = positivePence(s.captured_amount_pence);
    if (amt <= 0) continue;
    if (isVerifiedSettledCaptureSession(s)) {
      sum += amt;
      continue;
    }
    const blob = `${s.status ?? ""} ${s.provider_state ?? ""}`.toLowerCase();
    if (
      blob.includes("cancel")
      || blob.includes("fail")
      || blob.includes("void")
      || blob.includes("expir")
      || blob.includes("revers")
    ) {
      continue;
    }
    // Amount present = money moved; include for display even if status label is odd.
    sum += amt;
  }
  return sum;
}

export function sumDisplayAuthorisedFromSessions(
  sessions: TripHistoryPaymentLayerSession[],
): number {
  let maxAuth = 0;
  for (const s of sessions) {
    const auth = positivePence(
      s.total_authorised_amount_pence ?? s.authorised_amount_pence,
    );
    if (auth > maxAuth) maxAuth = auth;
  }
  return maxAuth;
}

export function sumLegacyPaymentsCapturedPence(
  payments: TripHistoryPaymentLayerPayment[],
): number {
  let sum = 0;
  for (const p of payments) {
    const fromCaptured = positivePence(p.captured_amount_pence);
    if (fromCaptured > 0) {
      sum += fromCaptured;
      continue;
    }
    const status = String(p.status ?? "").toLowerCase();
    if (status.includes("captur") || status.includes("succeeded") || status.includes("paid")) {
      sum += positivePence(p.amount_pence);
    }
  }
  return sum;
}

/**
 * Resolve customer payable including fee-only terminal trips
 * (no-show / cancellation / arrival cancellation).
 */
export function resolveTripHistoryCustomerPayablePence(
  trip: TripHistoryPaymentLayerTrip,
): { payable_pence: number; source: string } {
  const tip = positivePence(trip.tip_pence ?? trip.tip_amount_pence);
  const arrivalFee = arrivalCancellationPence(trip);
  const canonical = resolveCanonicalCustomerPayablePence({
    finalCustomerFarePence: trip.final_customer_fare_pence,
    finalFarePence: trip.final_fare_pence,
    noShowChargePence: trip.no_show_charge_pence,
    cancellationFeePence: Math.max(
      positivePence(trip.cancellation_fee_pence),
      arrivalFee,
    ),
    outstandingBalancePence: trip.outstanding_balance_pence,
  });

  if (canonical.payable_pence != null && canonical.payable_pence > 0) {
    // tip is usually inside final fare; only add when payable came from fee-only columns
    if (
      canonical.source === "no_show_charge_pence"
      || canonical.source === "cancellation_fee_pence"
    ) {
      return {
        payable_pence: canonical.payable_pence + tip,
        source: canonical.source,
      };
    }
    return {
      payable_pence: canonical.payable_pence + (canonical.source.startsWith("final") ? tip : 0),
      source: canonical.source,
    };
  }

  if (arrivalFee > 0) {
    return { payable_pence: arrivalFee + tip, source: "arrival_cancellation_fee" };
  }

  return { payable_pence: 0, source: canonical.source };
}

/**
 * Unify the 4 payment layers for Trip History Payment status panel.
 */
export function resolveTripHistoryPaymentLayers(args: {
  sessions?: TripHistoryPaymentLayerSession[] | null;
  trip: TripHistoryPaymentLayerTrip;
  payments?: TripHistoryPaymentLayerPayment[] | null;
  /** Live provider completed/captured amount (Revolut order). */
  providerCapturedPence?: number | null;
  providerAuthorisedPence?: number | null;
}): TripHistoryPaymentLayers {
  const sessions = args.sessions ?? [];
  const payments = args.payments ?? [];

  const sessionCaptured = sumDisplayCapturedFromSessions(sessions);
  const tripCaptured = positivePence(args.trip.capture_amount_pence);
  const legacyCaptured = sumLegacyPaymentsCapturedPence(payments);
  const providerCaptured = positivePence(args.providerCapturedPence);

  let captured_pence = 0;
  let evidence_source: TripHistoryPaymentLayers["evidence_source"] = "none";
  if (sessionCaptured > 0) {
    captured_pence = sessionCaptured;
    evidence_source = "payment_sessions";
  } else if (tripCaptured > 0) {
    captured_pence = tripCaptured;
    evidence_source = "trip_capture";
  } else if (legacyCaptured > 0) {
    captured_pence = legacyCaptured;
    evidence_source = "legacy_payments";
  } else if (providerCaptured > 0) {
    captured_pence = providerCaptured;
    evidence_source = "provider_live";
  }

  // Prefer the strongest evidence when multiple sources exist (never shrink).
  captured_pence = Math.max(captured_pence, sessionCaptured, tripCaptured, legacyCaptured, providerCaptured);
  if (captured_pence > 0 && evidence_source === "none") {
    evidence_source = sessionCaptured > 0
      ? "payment_sessions"
      : tripCaptured > 0
        ? "trip_capture"
        : legacyCaptured > 0
          ? "legacy_payments"
          : "provider_live";
  }

  const authorized_pence = Math.max(
    sumDisplayAuthorisedFromSessions(sessions),
    positivePence(args.trip.authorised_amount_pence),
    positivePence(args.providerAuthorisedPence),
    captured_pence, // completed capture implies at least that much was authorised
  );

  const sessionRefunded = sumVerifiedRefundedFromSessions(sessions);
  const refunded_pence = Math.max(
    sessionRefunded,
    positivePence(args.trip.refund_amount_pence),
  );

  const refundable_pence = Math.max(0, captured_pence - refunded_pence);
  const payable = resolveTripHistoryCustomerPayablePence(args.trip);

  const has_payment_evidence = captured_pence > 0
    || authorized_pence > 0
    || refunded_pence > 0
    || payable.payable_pence > 0;

  return {
    authorized_pence,
    captured_pence,
    refunded_pence,
    refundable_pence,
    customer_payable_pence: payable.payable_pence,
    payable_source: payable.source,
    evidence_source,
    has_payment_evidence,
  };
}
