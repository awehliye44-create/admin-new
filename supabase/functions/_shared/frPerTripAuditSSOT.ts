/**
 * Financial Reconciliation — one per-trip audit record SSOT (audit-only, zero money writes).
 * All overview cards, counters, and alerts must aggregate these records — never independent formulas.
 */

import {
  confirmedCapturePence,
  type PaymentSessionMoneyRow,
  type PaymentSessionMoneyByTrip,
} from "./financialReconciliationSSOT.ts";
import {
  isVerifiedSettledCaptureSession,
  sumVerifiedCapturedFromSessions,
} from "./tripHistoryShortfallRecaptureSSOT.ts";
import {
  resolveLockedPromotionPence,
  resolvePrePromotionCommissionableFarePence,
} from "./tripSettlement.ts";
import { SERVICE_AREA_FINANCIAL_MODEL } from "./commissionWalletSSOT.ts";
import {
  evaluateFrSettlementCaptureIdentity,
  isFrTripFullyBalanced,
  resolveFrTripAuditStatus,
  FR_TRIP_AUDIT_STATUS,
} from "./frConsumeOnlySSOT.ts";

export const FR_PAYMENT_SESSION_RESOLUTION = {
  RESOLVED: "RESOLVED",
  PAYMENT_SESSION_AMBIGUOUS: "PAYMENT_SESSION_AMBIGUOUS",
} as const;

export type FrPaymentSessionResolutionStatus =
  typeof FR_PAYMENT_SESSION_RESOLUTION[keyof typeof FR_PAYMENT_SESSION_RESOLUTION];

export type FrProviderFeeStatus =
  | "CONFIRMED"
  | "CONFIRMED_ZERO"
  | "PENDING"
  | "UNAVAILABLE";

export type CanonicalPaymentSessionMoney = PaymentSessionMoneyByTrip & {
  canonical_payment_session_ids: string[];
  session_resolution_status: FrPaymentSessionResolutionStatus;
  ambiguous_sessions?: Array<{
    payment_session_id: string | null;
    purpose: string | null;
    captured_amount_pence: number | null;
    status: string | null;
  }>;
};

const TERMINAL_OBSOLETE_STATUSES = new Set([
  "cancelled",
  "canceled",
  "failed",
  "void",
  "voided",
  "expired",
  "abandoned",
  "superseded",
  "obsolete",
]);

function upperPurpose(purpose: string | null | undefined): string {
  return String(purpose ?? "").trim().toUpperCase();
}

function isObsoleteSession(session: PaymentSessionMoneyRow): boolean {
  const status = String(session.status ?? "").trim().toLowerCase();
  const provider = String(session.provider_state ?? "").trim().toLowerCase();
  return TERMINAL_OBSOLETE_STATUSES.has(status) || TERMINAL_OBSOLETE_STATUSES.has(provider);
}

function isBookingPurpose(purpose: string): boolean {
  return purpose === "RIDE_BOOKING" || purpose === "BOOKING" || purpose === "";
}

function isRecoveryPurpose(purpose: string): boolean {
  return purpose === "PAYMENT_RECOVERY";
}

function isConfirmedFeeStatus(feeStatus: string | null | undefined): boolean {
  const s = String(feeStatus ?? "").toUpperCase();
  return s === "ACTUAL" || s === "CONFIRMED";
}

/** Classify provider fee from Payment Sessions — never silently treat null as confirmed zero. */
export function classifyFrProviderFeeFromSession(args: {
  provider_processing_fee_pence: number | null | undefined;
  fee_status: string | null | undefined;
  sessionsMapPresent: boolean;
  fee_confirmed_at?: string | null;
}): {
  confirmed_provider_fee_pence: number | null;
  pending_provider_fee_pence: number | null;
  fee_status: FrProviderFeeStatus;
  fee_source: "payment_session" | null;
  fee_confirmed_at: string | null;
} {
  if (!args.sessionsMapPresent) {
    return {
      confirmed_provider_fee_pence: null,
      pending_provider_fee_pence: null,
      fee_status: "UNAVAILABLE",
      fee_source: null,
      fee_confirmed_at: null,
    };
  }
  const raw = args.provider_processing_fee_pence;
  if (!isConfirmedFeeStatus(args.fee_status)) {
    return {
      confirmed_provider_fee_pence: null,
      pending_provider_fee_pence: raw != null ? Math.max(0, Math.round(Number(raw))) : null,
      fee_status: "PENDING",
      fee_source: "payment_session",
      fee_confirmed_at: null,
    };
  }
  if (raw == null) {
    return {
      confirmed_provider_fee_pence: null,
      pending_provider_fee_pence: null,
      fee_status: "PENDING",
      fee_source: "payment_session",
      fee_confirmed_at: null,
    };
  }
  const fee = Math.max(0, Math.round(Number(raw)));
  return {
    confirmed_provider_fee_pence: fee,
    pending_provider_fee_pence: null,
    fee_status: fee === 0 ? "CONFIRMED_ZERO" : "CONFIRMED",
    fee_source: "payment_session",
    fee_confirmed_at: args.fee_confirmed_at ?? null,
  };
}

/**
 * Canonical Payment Session resolution per trip — no blind summing of every session row.
 * Uses verified booking + recovery captures; max auth; fee from primary capture session.
 */
export function resolveCanonicalPaymentSessionMoneyForTrip(
  sessions: PaymentSessionMoneyRow[],
): CanonicalPaymentSessionMoney | null {
  if (sessions.length === 0) return null;

  const active = sessions.filter((s) => !isObsoleteSession(s));
  const working = active.length > 0 ? active : sessions;

  const verifiedBookingCaptures = working.filter((s) =>
    isBookingPurpose(upperPurpose(s.purpose ?? null))
    && isVerifiedSettledCaptureSession(s)
  );
  const verifiedRecoveryCaptures = working.filter((s) =>
    isRecoveryPurpose(upperPurpose(s.purpose ?? null))
    && isVerifiedSettledCaptureSession(s)
  );

  // Ambiguous: multiple explicit RIDE_BOOKING captures with different amounts.
  const explicitBookingCaptures = verifiedBookingCaptures.filter((s) =>
    upperPurpose(s.purpose ?? null) === "RIDE_BOOKING"
  );
  if (explicitBookingCaptures.length > 1) {
    const amounts = explicitBookingCaptures.map((s) =>
      confirmedCapturePence(s.captured_amount_pence)
    );
    const unique = new Set(amounts.filter((a) => a != null));
    if (unique.size > 1) {
      return {
        payment_session_id: verifiedBookingCaptures[0]?.id ?? null,
        captured_amount_pence: null,
        authorised_amount_pence: null,
        released_amount_pence: null,
        refunded_amount_pence: null,
        provider_processing_fee_pence: null,
        fee_status: null,
        provider_state: null,
        provider_state_verified_at: null,
        release_evidence_status: null,
        payment_method: null,
        status: null,
        metadata: null,
        canonical_payment_session_ids: working.map((s) => s.id ?? "").filter(Boolean),
        session_resolution_status: FR_PAYMENT_SESSION_RESOLUTION.PAYMENT_SESSION_AMBIGUOUS,
        ambiguous_sessions: explicitBookingCaptures.map((s) => ({
          payment_session_id: s.id ?? null,
          purpose: s.purpose ?? null,
          captured_amount_pence: confirmedCapturePence(s.captured_amount_pence),
          status: s.status ?? null,
        })),
      };
    }
  }

  const captureTotals = sumVerifiedCapturedFromSessions(working.map((s) => ({
    purpose: s.purpose ?? null,
    status: s.status ?? null,
    provider_state: s.provider_state ?? null,
    captured_amount_pence: s.captured_amount_pence ?? null,
  })));
  const captured = captureTotals.total_verified_captured_pence > 0
    ? captureTotals.total_verified_captured_pence
    : null;

  let maxAuth: number | null = null;
  let releasedSum = 0;
  let refundedSum = 0;
  let hasReleased = false;
  let hasRefunded = false;
  for (const s of working) {
    const authRaw = s.total_authorised_amount_pence ?? s.authorised_amount_pence;
    if (authRaw != null && Number.isFinite(Number(authRaw))) {
      const auth = Math.max(0, Math.round(Number(authRaw)));
      maxAuth = maxAuth == null ? auth : Math.max(maxAuth, auth);
    }
    if (s.released_amount_pence != null) {
      hasReleased = true;
      releasedSum += Math.max(0, Math.round(Number(s.released_amount_pence)));
    }
    if (s.refunded_amount_pence != null) {
      hasRefunded = true;
      refundedSum += Math.max(0, Math.round(Number(s.refunded_amount_pence)));
    }
  }

  // Primary session = booking capture with confirmed capture, else highest capture session.
  const primaryCandidates = [
    ...verifiedBookingCaptures,
    ...verifiedRecoveryCaptures,
    ...working.filter((s) => confirmedCapturePence(s.captured_amount_pence) != null),
  ];
  const primary = primaryCandidates.sort((a, b) =>
    (confirmedCapturePence(b.captured_amount_pence) ?? 0)
    - (confirmedCapturePence(a.captured_amount_pence) ?? 0),
  )[0] ?? working[0];

  const sessionIds = [...new Set(working.map((s) => s.id).filter(Boolean))] as string[];

  return {
    payment_session_id: primary?.id ?? null,
    captured_amount_pence: captured,
    authorised_amount_pence: maxAuth,
    released_amount_pence: hasReleased ? releasedSum : null,
    refunded_amount_pence: hasRefunded ? refundedSum : null,
    provider_processing_fee_pence: primary?.provider_processing_fee_pence != null
      ? Math.max(0, Math.round(Number(primary.provider_processing_fee_pence)))
      : null,
    fee_status: primary?.fee_status ?? null,
    provider_state: primary?.provider_state ?? null,
    provider_state_verified_at: primary?.provider_state_verified_at ?? null,
    release_evidence_status: primary?.release_evidence_status ?? null,
    payment_method: primary?.payment_method ?? null,
    status: primary?.status ?? null,
    metadata: (primary?.metadata && typeof primary.metadata === "object")
      ? primary.metadata as Record<string, unknown>
      : null,
    canonical_payment_session_ids: sessionIds,
    session_resolution_status: FR_PAYMENT_SESSION_RESOLUTION.RESOLVED,
  };
}

/** Build per-trip map using canonical session resolution. */
export function resolveCanonicalPaymentSessionMoneyByTrip(
  sessions: PaymentSessionMoneyRow[],
): Map<string, CanonicalPaymentSessionMoney> {
  const byTrip = new Map<string, PaymentSessionMoneyRow[]>();
  for (const s of sessions) {
    if (!s.trip_id) continue;
    const list = byTrip.get(s.trip_id) ?? [];
    list.push(s);
    byTrip.set(s.trip_id, list);
  }
  const out = new Map<string, CanonicalPaymentSessionMoney>();
  for (const [tripId, tripSessions] of byTrip) {
    const resolved = resolveCanonicalPaymentSessionMoneyForTrip(tripSessions);
    if (resolved) out.set(tripId, resolved);
  }
  return out;
}

export function resolveTripCommissionAfterPromotionPence(trip: {
  commission_pence?: number | null;
  offer_discount_pence?: number | null;
  discount_source?: string | null;
  locked_base_fare_pence?: number | null;
  fare_snapshot_json?: Record<string, unknown> | null;
  gross_fare_pence?: number | null;
  final_fare_pence?: number | null;
  customer_modification_charge_pence?: number | null;
  commissionable_fare_pence?: number | null;
  driver_net_pence?: number | null;
}): number | null {
  if (trip.commission_pence == null) return null;
  const gross = Math.round(Number(trip.commission_pence));
  const locked = resolveLockedPromotionPence(trip);
  if (locked <= 0) return gross;
  // A promotion absorbs ONECAB commission only when settlement used the pre-promotion
  // commissionable base. Authoritative evidence: stored commissionable_fare_pence differs
  // from final_fare_pence, meaning commission was on the higher pre-promo fare.
  // When settlement ran on final_fare (no pre-promo path), the promotion was priced into
  // the customer fare and driver_net+commission already equals final_fare — no ONECAB absorption.
  const prePromoCommissionable = resolvePrePromotionCommissionableFarePence(trip);
  const finalFare = trip.final_fare_pence != null
    ? Math.max(0, Math.round(Number(trip.final_fare_pence)))
    : null;
  // Check saved commissionable_fare_pence stamp — authoritative if present.
  const savedCommissionable = trip.commissionable_fare_pence != null
    ? Math.max(0, Math.round(Number(trip.commissionable_fare_pence)))
    : null;
  // Promotion was applied to ONECAB commission only when the saved commissionable fare
  // equals the pre-promotion commissionable base (not the final fare).
  const promotionAbsorbedByOnecab = savedCommissionable != null && finalFare != null
    ? savedCommissionable > finalFare  // settlement used pre-promo base
    : prePromoCommissionable > 0 && finalFare != null && prePromoCommissionable > finalFare;
  if (promotionAbsorbedByOnecab) return gross - locked;
  return gross;
}

export function resolveTripPrePromotionCommissionableFarePence(trip: {
  commissionable_fare_pence?: number | null;
  gross_fare_pence?: number | null;
  final_fare_pence?: number | null;
  offer_discount_pence?: number | null;
  locked_base_fare_pence?: number | null;
  customer_modification_charge_pence?: number | null;
  fare_snapshot_json?: Record<string, unknown> | null;
}): number | null {
  const pre = resolvePrePromotionCommissionableFarePence(trip);
  return pre > 0 ? pre : (trip.commissionable_fare_pence != null
    ? Math.max(0, Math.round(Number(trip.commissionable_fare_pence)))
    : null);
}

/**
 * How the promotion was applied relative to the customer's final capture.
 * APPLIED_TO_ONECAB: promotion reduced ONECAB commission; settlement ran on pre-promo fare.
 * NOT_APPLIED: promotion was locked but not absorbed by ONECAB (final fare already reflects it).
 * PENDING_EVIDENCE: cannot determine from saved stamps alone — FR must not guess.
 */
export type FrPromotionApplicationStatus =
  | "APPLIED_TO_ONECAB"
  | "NOT_APPLIED"
  | "NO_PROMOTION"
  | "PENDING_EVIDENCE"
  /**
   * The settlement ran on the post-discount commissionable fare instead of the
   * original pre-promotion fare + modifications.  Driver entitlement was under-calculated.
   * This is a booking-time settlement defect — FR reports it; it does not repair it.
   */
  | "SETTLEMENT_BASE_DEFECT";

export type FrPerTripAuditRecord = {
  trip_id: string;
  trip_code: string | null;
  completed_at: string | null;
  financial_model: string | null;
  canonical_payment_session_ids: string[];
  payment_session_resolution_status: FrPaymentSessionResolutionStatus;
  authorised_amount_pence: number | null;
  captured_amount_pence: number | null;
  refunded_amount_pence: number | null;
  released_amount_pence: number | null;
  confirmed_provider_fee_pence: number | null;
  pending_provider_fee_pence: number | null;
  provider_fee_status: FrProviderFeeStatus;
  provider_fee_source: "payment_session" | null;
  provider_fee_confirmed_at: string | null;
  /** Original pre-promotion fare from locked snapshot (gross_fare_pence / original_fare_pence). */
  original_trip_price_pence: number | null;
  /** Full-price customer modification charge (receives no promotion). */
  modification_charge_pence: number | null;
  /** Expected commissionable fare = original_trip_price + modification_charge. */
  canonical_commissionable_fare_pence: number | null;
  pre_promotion_commissionable_fare_pence: number | null;
  /** Stored global_offer discount pence — may or may not be absorbed by ONECAB. */
  locked_promotion_pence: number;
  /** Platform-funded promotion subsidy (marketing cost) — deducted in the FR identity. */
  platform_promotion_subsidy_pence?: number | null;
  /** Promotion actually absorbed by ONECAB commission (0 when not applied). */
  applied_promotion_pence: number;
  /** Portion of locked promotion not absorbed by ONECAB. */
  unapplied_promotion_pence: number;
  /** Whether the promotion was applied to ONECAB commission, not applied, or evidence missing. */
  promotion_application_status: FrPromotionApplicationStatus;
  /** Authoritative reason for promotion application decision. */
  promotion_application_reason: string;
  gross_commission_pence: number | null;
  /** Gross commission minus applied promotion only — not the full locked amount if not absorbed. */
  commission_after_applied_promotion_pence: number | null;
  /** @deprecated alias for commission_after_applied_promotion_pence */
  commission_after_promotion_pence: number | null;
  driver_entitlement_pence: number | null;
  actual_trip_earning_net_pence: number | null;
  capture_variance_pence: number | null;
  wallet_variance_pence: number | null;
  capture_status: string | null;
  wallet_status: string | null;
  commission_status: string | null;
  fee_status: string | null;
  final_reconciliation_status: string;
  evidence_codes: string[];
  evaluable: boolean;
  pending_reason: string | null;
};

export type FrPeriodAuditSummary = {
  evaluated_trip_count: number;
  pending_trip_count: number;
  matched_trip_count: number;
  mismatched_trip_count: number;
  pending_trips: Array<{
    trip_id: string;
    trip_code: string | null;
    pending_reason: string;
  }>;
  wallet_gap_total_pence: number;
  wallet_gap_trips: Array<{
    trip_id: string;
    trip_code: string | null;
    expected_driver_entitlement_pence: number;
    actual_trip_earning_net_pence: number;
    wallet_variance_pence: number;
    wallet_status: string;
  }>;
};

export type FrAuditOverviewFromTripRecords = {
  completed_trip_fare_total_pence: number;
  confirmed_provider_captured_total_pence: number;
  total_authorised_pence: number;
  expected_released_pence: number;
  released_total_pence: number;
  release_amount_unconfirmed_count: number;
  refunded_total_pence: number;
  waiting_charges_total_pence: number;
  provider_fee_total_pence: number;
  provider_fee_pending_total_pence: number;
  onecab_gross_commission_pence: number;
  onecab_net_commission_pence: number | null;
  driver_net_total_pence: number;
  wallet_credits_total_pence: number;
  payouts_completed_pence: number;
  airport_charges_total_pence: number;
  driver_tips_total_pence: number;
  commissionable_fare_total_pence: number;
  settlement_identity_variance_pence: number | null;
  settlement_identity_balanced: boolean;
  settlement_identity_evaluable_trip_count: number;
  settlement_identity_pending_trip_count: number;
  unallocated_pence: number | null;
  capture_shortfall_pence: number;
  overcapture_pence: number;
  missing_captures_count: number;
  missing_releases_count: number;
  missing_wallet_credits_count: number;
  payout_mismatches_count: number;
  wallet_mismatches_count: number;
  balanced_trips_count: number;
  unresolved_mismatches_count: number;
  trip_count: number;
  evaluated_trip_count: number;
  pending_trip_count: number;
  matched_trip_count: number;
  mismatched_trip_count: number;
};

function derivePendingReason(row: {
  payment_session_resolution_status?: string | null;
  capture_reconciliation_status?: string | null;
  wallet_reconciliation_status?: string | null;
  provider_fee_status?: string | null;
  settlement_identity_evaluable?: boolean;
  driver_entitlement_pence?: number | null;
  captured_amount_pence?: number | null;
}): string | null {
  if (row.payment_session_resolution_status === FR_PAYMENT_SESSION_RESOLUTION.PAYMENT_SESSION_AMBIGUOUS) {
    return "Payment Session ambiguous";
  }
  if (row.capture_reconciliation_status === "CAPTURE_AMOUNT_UNKNOWN"
    || row.capture_reconciliation_status === "CAPTURE_PENDING"
    || row.capture_reconciliation_status === "PROVIDER_VERIFICATION_PENDING"
    || row.captured_amount_pence == null) {
    return "Capture unknown";
  }
  if (row.provider_fee_status === "PENDING" || row.provider_fee_status === "UNAVAILABLE") {
    return "Provider fee pending";
  }
  if (row.wallet_reconciliation_status === "WALLET_CREDIT_PENDING"
    || row.wallet_reconciliation_status === "WALLET_EVIDENCE_UNAVAILABLE") {
    return "Wallet credit pending";
  }
  if (row.settlement_identity_evaluable === false
    && row.driver_entitlement_pence == null) {
    return "Settlement stamps missing";
  }
  return null;
}

/**
 * Classify whether a locked promotion was actually absorbed by ONECAB commission.
 * Uses only saved settlement stamps — never re-derives from fare fields alone.
 * Returns PENDING_EVIDENCE when the evidence is ambiguous rather than guessing.
 */
export function classifyFrPromotionApplication(trip: {
  commission_pence?: number | null;
  commissionable_fare_pence?: number | null;
  final_fare_pence?: number | null;
  driver_net_pence?: number | null;
  offer_discount_pence?: number | null;
  discount_source?: string | null;
  locked_base_fare_pence?: number | null;
  fare_snapshot_json?: Record<string, unknown> | null;
  customer_modification_charge_pence?: number | null;
}): {
  promotion_application_status: FrPromotionApplicationStatus;
  promotion_application_reason: string;
  applied_promotion_pence: number;
  unapplied_promotion_pence: number;
  /** The correct commissionable fare = original_pre_promotion_fare + modification_charge. */
  canonical_commissionable_fare_pence: number | null;
  /** The original pre-promotion fare from locked snapshot. */
  original_trip_price_pence: number | null;
} {
  const locked = resolveLockedPromotionPence(trip);

  // Resolve original pre-promotion fare from snapshot evidence.
  // fare_snapshot_json.original_fare_pence is the most authoritative.
  const snap = trip.fare_snapshot_json && typeof trip.fare_snapshot_json === "object"
    ? trip.fare_snapshot_json as Record<string, unknown>
    : {};
  const snapOriginal = snap.original_fare_pence != null
    ? Math.max(0, Math.round(Number(snap.original_fare_pence)))
    : (snap.gross_fare_pence != null
      ? Math.max(0, Math.round(Number(snap.gross_fare_pence)))
      : null);
  // locked_base_fare_pence stores the fare at booking commitment (pre-discount).
  const lockedBase = trip.locked_base_fare_pence != null
    ? Math.max(0, Math.round(Number(trip.locked_base_fare_pence)))
    : null;
  const originalFare = snapOriginal ?? lockedBase;

  const modCharge = trip.customer_modification_charge_pence != null
    ? Math.max(0, Math.round(Number(trip.customer_modification_charge_pence)))
    : 0;

  const canonicalCommissionable = originalFare != null
    ? originalFare + modCharge
    : null;

  if (locked <= 0) {
    return {
      promotion_application_status: "NO_PROMOTION",
      promotion_application_reason: "No global_offer discount on this trip",
      applied_promotion_pence: 0,
      unapplied_promotion_pence: 0,
      canonical_commissionable_fare_pence: canonicalCommissionable,
      original_trip_price_pence: originalFare,
    };
  }

  const commission = trip.commission_pence != null
    ? Math.round(Number(trip.commission_pence)) : null;
  const driverNet = trip.driver_net_pence != null
    ? Math.max(0, Math.round(Number(trip.driver_net_pence))) : null;
  const savedCommissionable = trip.commissionable_fare_pence != null
    ? Math.max(0, Math.round(Number(trip.commissionable_fare_pence))) : null;
  const finalFare = trip.final_fare_pence != null
    ? Math.max(0, Math.round(Number(trip.final_fare_pence))) : null;

  // Without commission and driver_net stamps, we cannot evaluate.
  if (commission == null || driverNet == null) {
    return {
      promotion_application_status: "PENDING_EVIDENCE",
      promotion_application_reason:
        "commission_pence or driver_net_pence missing — settlement stamp not yet written",
      applied_promotion_pence: 0,
      unapplied_promotion_pence: locked,
      canonical_commissionable_fare_pence: canonicalCommissionable,
      original_trip_price_pence: originalFare,
    };
  }

  // Hard business rule: driver entitlement must be calculated from
  // original_pre_promotion_fare + modification_charge (canonical commissionable base).
  // If saved commissionable_fare_pence was instead set to the post-discount fare,
  // the settlement ran on the wrong base and underpaid the driver.
  if (
    canonicalCommissionable != null
    && savedCommissionable != null
    && savedCommissionable !== canonicalCommissionable
    && finalFare != null
    // The defect pattern: savedCommissionable = originalFare - promotion (promotion subtracted from fare base).
    && savedCommissionable === finalFare - modCharge  // final_fare = original - promotion + mod; final - mod = original - promotion
    // Distinguish from legitimate partial-mod scenarios: only flag when this is clearly the discount reduction.
    && locked > 0
  ) {
    const expectedCommission = commission;
    const expectedDriverNet = driverNet;
    const correctCommissionable = canonicalCommissionable;
    return {
      promotion_application_status: "SETTLEMENT_BASE_DEFECT",
      promotion_application_reason:
        `Settlement ran on post-discount base: saved commissionable_fare_pence=${savedCommissionable}p `
        + `but canonical (original_fare=${originalFare}p + mod=${modCharge}p) = ${correctCommissionable}p. `
        + `Driver entitlement was calculated from discounted fare — underpaid by `
        + `${correctCommissionable - savedCommissionable}p. `
        + `Commission and driver_net in saved stamps are based on wrong (discounted) fare base. `
        + `FR audit only — settlement stamps not corrected.`,
      applied_promotion_pence: 0,
      unapplied_promotion_pence: locked,
      canonical_commissionable_fare_pence: canonicalCommissionable,
      original_trip_price_pence: originalFare,
    };
  }

  const sumDriverAndCommission = driverNet + commission;

  if (savedCommissionable != null && finalFare != null) {
    // APPLIED_TO_ONECAB: settlement used pre-promo base; driver+commission = commissionable > final_fare.
    if (savedCommissionable > finalFare && sumDriverAndCommission === savedCommissionable) {
      return {
        promotion_application_status: "APPLIED_TO_ONECAB",
        promotion_application_reason:
          `Settlement stamp: commissionable_fare_pence=${savedCommissionable} > final_fare=${finalFare}; `
          + `driver+commission=${sumDriverAndCommission} = commissionable base (pre-promo absorption by ONECAB)`,
        applied_promotion_pence: locked,
        unapplied_promotion_pence: 0,
        canonical_commissionable_fare_pence: canonicalCommissionable,
        original_trip_price_pence: originalFare,
      };
    }
    // NOT_APPLIED but not a base defect: promotion reduced customer fare; settlement on correct base.
    if (sumDriverAndCommission === savedCommissionable && savedCommissionable === finalFare) {
      return {
        promotion_application_status: "NOT_APPLIED",
        promotion_application_reason:
          `Settlement stamp: driver+commission=${sumDriverAndCommission} = commissionable_fare=${savedCommissionable} = final_fare; `
          + `no promotion absorbed by ONECAB — promotion was fully absorbed in fare pricing before capture`,
        applied_promotion_pence: 0,
        unapplied_promotion_pence: locked,
        canonical_commissionable_fare_pence: canonicalCommissionable,
        original_trip_price_pence: originalFare,
      };
    }
    return {
      promotion_application_status: "PENDING_EVIDENCE",
      promotion_application_reason:
        `Saved commissionable_fare_pence=${savedCommissionable}, final_fare=${finalFare}, `
        + `driver+commission=${sumDriverAndCommission} — no identity satisfied; cannot determine application`,
      applied_promotion_pence: 0,
      unapplied_promotion_pence: locked,
      canonical_commissionable_fare_pence: canonicalCommissionable,
      original_trip_price_pence: originalFare,
    };
  }

  // No saved commissionable stamp — fall back to pre-promo commissionable.
  const prePromoCommissionable = resolvePrePromotionCommissionableFarePence(trip);
  if (prePromoCommissionable > 0 && finalFare != null) {
    if (prePromoCommissionable > finalFare && sumDriverAndCommission === prePromoCommissionable) {
      return {
        promotion_application_status: "APPLIED_TO_ONECAB",
        promotion_application_reason:
          `pre_promotion_commissionable=${prePromoCommissionable} > final_fare=${finalFare}; `
          + `driver+commission=${sumDriverAndCommission} matches pre-promo base`,
        applied_promotion_pence: locked,
        unapplied_promotion_pence: 0,
        canonical_commissionable_fare_pence: canonicalCommissionable,
        original_trip_price_pence: originalFare,
      };
    }
    if (sumDriverAndCommission === finalFare) {
      return {
        promotion_application_status: "NOT_APPLIED",
        promotion_application_reason:
          `driver+commission=${sumDriverAndCommission} = final_fare=${finalFare}; `
          + `promotion not absorbed by ONECAB`,
        applied_promotion_pence: 0,
        unapplied_promotion_pence: locked,
        canonical_commissionable_fare_pence: canonicalCommissionable,
        original_trip_price_pence: originalFare,
      };
    }
  }

  return {
    promotion_application_status: "PENDING_EVIDENCE",
    promotion_application_reason:
      `Insufficient settlement stamps to determine promotion application; `
      + `missing saved commissionable_fare_pence or final_fare_pence`,
    applied_promotion_pence: 0,
    unapplied_promotion_pence: locked,
    canonical_commissionable_fare_pence: canonicalCommissionable,
    original_trip_price_pence: originalFare,
  };
}

/** Build per-trip audit record from mapped trip audit row + canonical session metadata. */
export function buildFrPerTripAuditRecord(args: {
  row: Record<string, unknown>;
  session?: CanonicalPaymentSessionMoney | null;
}): FrPerTripAuditRecord {
  const r = args.row;
  const tripId = String(r.trip_id ?? "");
  const grossCommission = r.onecab_gross_commission_pence != null
    ? Math.max(0, Math.round(Number(r.onecab_gross_commission_pence)))
    : null;
  const lockedPromotion = r.locked_promotion_pence != null
    ? Math.max(0, Math.round(Number(r.locked_promotion_pence)))
    : resolveLockedPromotionPence(r as Parameters<typeof resolveLockedPromotionPence>[0]);
  const prePromotion = r.pre_promotion_commissionable_fare_pence != null
    ? Math.max(0, Math.round(Number(r.pre_promotion_commissionable_fare_pence)))
    : resolveTripPrePromotionCommissionableFarePence(
      r as Parameters<typeof resolveTripPrePromotionCommissionableFarePence>[0],
    );

  // Classify promotion application from saved settlement evidence — do not guess.
  const promoClass = classifyFrPromotionApplication({
    commission_pence: r.commission_pence != null ? Number(r.commission_pence)
      : (r.onecab_gross_commission_pence != null ? Number(r.onecab_gross_commission_pence) : null),
    commissionable_fare_pence: r.commissionable_fare_pence != null
      ? Number(r.commissionable_fare_pence) : null,
    final_fare_pence: r.final_fare_pence != null ? Number(r.final_fare_pence) : null,
    driver_net_pence: r.driver_net_pence != null ? Number(r.driver_net_pence) : null,
    offer_discount_pence: r.offer_discount_pence != null ? Number(r.offer_discount_pence) : null,
    discount_source: r.discount_source as string | null ?? null,
    locked_base_fare_pence: r.locked_base_fare_pence != null
      ? Number(r.locked_base_fare_pence) : null,
    fare_snapshot_json: r.fare_snapshot_json as Record<string, unknown> | null ?? null,
    customer_modification_charge_pence: r.customer_modification_charge_pence != null
      ? Number(r.customer_modification_charge_pence) : null,
  });

  // commission_after_applied_promotion uses the applied portion only — never the full locked amount.
  const commissionAfter = grossCommission != null
    ? grossCommission - promoClass.applied_promotion_pence
    : null;

  const originalTripPrice = promoClass.original_trip_price_pence
    ?? (r.locked_base_fare_pence != null
      ? Math.max(0, Math.round(Number(r.locked_base_fare_pence)))
      : (prePromotion != null && prePromotion > 0 ? prePromotion : null));
  const modificationCharge = r.customer_modification_charge_pence != null
    ? Math.max(0, Math.round(Number(r.customer_modification_charge_pence)))
    : null;
  const driverEntitlement = r.driver_net_pence != null
    ? Math.max(0, Math.round(Number(r.driver_net_pence)))
    : null;
  const walletCreditRaw = r.wallet_credit_pence;
  const actualWallet = walletCreditRaw != null && Number(walletCreditRaw) > 0
    ? Math.round(Number(walletCreditRaw))
    : (walletCreditRaw === 0 ? 0 : null);

  const feeClass = classifyFrProviderFeeFromSession({
    provider_processing_fee_pence: r.confirmed_provider_fee_pence != null
      ? Number(r.confirmed_provider_fee_pence)
      : (args.session?.provider_processing_fee_pence != null
        ? Number(args.session.provider_processing_fee_pence)
        : (r.processing_fee_pence != null ? Number(r.processing_fee_pence) : null)),
    fee_status: (r.confirmed_provider_fee_pence != null
      ? "CONFIRMED"
      : (args.session?.fee_status ?? r.fee_status)) as string | null | undefined,
    sessionsMapPresent: args.session != null || r.payment_evidence_status === "PAYMENT_SESSIONS",
    fee_confirmed_at: args.session?.provider_state_verified_at ?? null,
  });

  const captured = r.captured_pence != null ? Math.round(Number(r.captured_pence)) : null;
  const airport = r.airport_charge_pence != null
    ? Math.max(0, Math.round(Number(r.airport_charge_pence)))
    : 0;
  const tips = r.tip_pence != null ? Math.max(0, Math.round(Number(r.tip_pence))) : 0;

  const settlementIdentity = evaluateFrSettlementCaptureIdentity({
    captured_pence: captured,
    driver_net_pence: driverEntitlement,
    commission_pence: grossCommission,
    commission_after_promotion_pence: commissionAfter,
    platform_promotion_subsidy_pence: r.platform_promotion_subsidy_pence ?? 0,
    airport_charge_pence: airport,
    tips_pence: tips,
  });

  const walletVariance = driverEntitlement == null || actualWallet == null
    ? (driverEntitlement != null && actualWallet === 0
      ? 0 - driverEntitlement
      : null)
    : actualWallet - driverEntitlement;

  const sessionResolution = args.session?.session_resolution_status
    ?? FR_PAYMENT_SESSION_RESOLUTION.RESOLVED;

  const evidenceCodes: string[] = [];
  if (sessionResolution === FR_PAYMENT_SESSION_RESOLUTION.PAYMENT_SESSION_AMBIGUOUS) {
    evidenceCodes.push("PAYMENT_SESSION_AMBIGUOUS");
  }
  if (feeClass.fee_status === "PENDING") evidenceCodes.push("PROVIDER_FEE_PENDING");
  if (r.wallet_reconciliation_status === "WALLET_CREDIT_MISSING") {
    evidenceCodes.push("WALLET_CREDIT_MISSING");
  }
  if (settlementIdentity.evaluable && !settlementIdentity.balanced) {
    evidenceCodes.push("SETTLEMENT_IDENTITY_MISMATCH");
  }
  if (promoClass.promotion_application_status === "SETTLEMENT_BASE_DEFECT") {
    evidenceCodes.push("SETTLEMENT_BASE_DEFECT");
  }

  const pendingReason = derivePendingReason({
    payment_session_resolution_status: sessionResolution,
    capture_reconciliation_status: String(r.capture_reconciliation_status ?? ""),
    wallet_reconciliation_status: String(r.wallet_reconciliation_status ?? ""),
    provider_fee_status: feeClass.fee_status,
    settlement_identity_evaluable: settlementIdentity.evaluable,
    driver_entitlement_pence: driverEntitlement,
    captured_amount_pence: captured,
  });

  const evaluable = pendingReason == null && settlementIdentity.evaluable;

  const finalStatus = resolveFrTripAuditStatus({
    capture_reconciliation_status: String(r.capture_reconciliation_status ?? ""),
    release_reconciliation_status: String(r.release_reconciliation_status ?? ""),
    wallet_reconciliation_status: String(r.wallet_reconciliation_status ?? ""),
    payout_reconciliation_status: String(r.payout_reconciliation_status ?? ""),
    fee_status: feeClass.fee_status === "PENDING" ? "PENDING" : String(r.fee_status ?? ""),
    settlement_identity_balanced: settlementIdentity.balanced,
    payment_evidence_status: String(r.payment_evidence_status ?? ""),
    promotion_application_status: promoClass.promotion_application_status,
  });

  return {
    trip_id: tripId,
    trip_code: (r.trip_code as string | null) ?? null,
    completed_at: (r.date as string | null) ?? null,
    financial_model: (r.financial_model as string | null) ?? SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED,
    canonical_payment_session_ids: args.session?.canonical_payment_session_ids ?? (
      r.payment_session_id ? [String(r.payment_session_id)] : []
    ),
    payment_session_resolution_status: sessionResolution,
    authorised_amount_pence: r.authorised_pence != null
      ? Math.round(Number(r.authorised_pence))
      : null,
    captured_amount_pence: captured,
    refunded_amount_pence: r.refunded_pence != null
      ? Math.max(0, Math.round(Number(r.refunded_pence)))
      : null,
    released_amount_pence: r.released_pence != null
      ? Math.max(0, Math.round(Number(r.released_pence)))
      : null,
    confirmed_provider_fee_pence: feeClass.confirmed_provider_fee_pence,
    pending_provider_fee_pence: feeClass.pending_provider_fee_pence,
    provider_fee_status: feeClass.fee_status,
    provider_fee_source: feeClass.fee_source,
    provider_fee_confirmed_at: feeClass.fee_confirmed_at,
    original_trip_price_pence: originalTripPrice,
    modification_charge_pence: modificationCharge,
    canonical_commissionable_fare_pence: promoClass.canonical_commissionable_fare_pence,
    pre_promotion_commissionable_fare_pence: prePromotion,
    locked_promotion_pence: lockedPromotion,
    applied_promotion_pence: promoClass.applied_promotion_pence,
    unapplied_promotion_pence: promoClass.unapplied_promotion_pence,
    promotion_application_status: promoClass.promotion_application_status,
    promotion_application_reason: promoClass.promotion_application_reason,
    gross_commission_pence: grossCommission,
    commission_after_applied_promotion_pence: commissionAfter,
    commission_after_promotion_pence: commissionAfter, // alias
    driver_entitlement_pence: driverEntitlement,
    actual_trip_earning_net_pence: actualWallet,
    capture_variance_pence: settlementIdentity.variance_pence,
    wallet_variance_pence: walletVariance,
    capture_status: String(r.capture_reconciliation_status ?? ""),
    wallet_status: String(r.wallet_reconciliation_status ?? ""),
    commission_status: settlementIdentity.evaluable
      ? (settlementIdentity.balanced ? "COMMISSION_MATCHED" : "COMMISSION_MISMATCH")
      : "COMMISSION_PENDING",
    fee_status: feeClass.fee_status,
    final_reconciliation_status: finalStatus,
    evidence_codes: evidenceCodes,
    evaluable,
    pending_reason: pendingReason,
  };
}

/** Aggregate overview KPIs strictly from per-trip audit records — single SSOT for all cards. */
export function aggregateFrOverviewFromPerTripRecords(
  records: FrPerTripAuditRecord[],
  auditRows: Array<Record<string, unknown>> = [],
): FrAuditOverviewFromTripRecords {
  let fare = 0;
  let captured = 0;
  let authorised = 0;
  let expectedReleased = 0;
  let refunded = 0;
  let released = 0;
  let confirmedFees = 0;
  let pendingFees = 0;
  let gross = 0;
  let netSum = 0;
  let netKnown = true;
  let driverNet = 0;
  let walletCredits = 0;
  let airportTotal = 0;
  let tipsTotal = 0;
  let waitingTotal = 0;
  let commissionableTotal = 0;
  let payoutsCompleted = 0;
  let shortfall = 0;
  let overcapture = 0;
  let missingCaptures = 0;
  let missingReleases = 0;
  let releaseUnconfirmed = 0;
  let missingWallet = 0;
  let payoutMismatch = 0;
  let walletMismatch = 0;
  let balanced = 0;
  let unresolved = 0;
  let identityVariance = 0;
  let identityEvaluableCount = 0;
  let identityPendingCount = 0;

  let evaluated = 0;
  let pending = 0;
  let matched = 0;
  let mismatched = 0;

  const rowByTrip = new Map(auditRows.map((r) => [String(r.trip_id), r]));

  for (const rec of records) {
    const row = rowByTrip.get(rec.trip_id) ?? {};

    if (row.ps_expected_capture_pence != null) {
      fare += Math.max(0, Number(row.ps_expected_capture_pence));
    }
    if (rec.captured_amount_pence != null && rec.captured_amount_pence > 0) {
      captured += rec.captured_amount_pence;
    }
    if (rec.authorised_amount_pence != null && rec.authorised_amount_pence > 0) {
      authorised += rec.authorised_amount_pence;
    }
    if (rec.authorised_amount_pence != null && rec.captured_amount_pence != null) {
      expectedReleased += Math.max(0, rec.authorised_amount_pence - rec.captured_amount_pence);
    }
    if (rec.refunded_amount_pence != null) refunded += rec.refunded_amount_pence;
    if (rec.released_amount_pence != null) released += rec.released_amount_pence;
    if (rec.confirmed_provider_fee_pence != null) {
      confirmedFees += rec.confirmed_provider_fee_pence;
    }
    if (rec.pending_provider_fee_pence != null) {
      pendingFees += rec.pending_provider_fee_pence;
    }
    if (rec.gross_commission_pence != null) gross += rec.gross_commission_pence;
    if (rec.provider_fee_status === "PENDING" || rec.provider_fee_status === "UNAVAILABLE") {
      netKnown = false;
    } else if (rec.gross_commission_pence != null && rec.confirmed_provider_fee_pence != null) {
      netSum += Math.max(0, rec.gross_commission_pence - rec.confirmed_provider_fee_pence);
    } else {
      netKnown = false;
    }
    if (rec.driver_entitlement_pence != null) driverNet += rec.driver_entitlement_pence;
    if (rec.actual_trip_earning_net_pence != null) {
      walletCredits += Math.max(0, rec.actual_trip_earning_net_pence);
    }
    if (row.airport_charge_pence != null) {
      airportTotal += Math.max(0, Number(row.airport_charge_pence));
    }
    if (row.tip_pence != null) tipsTotal += Math.max(0, Number(row.tip_pence));
    waitingTotal += Math.max(0, Number(row.pickup_waiting_charge_pence ?? 0))
      + Math.max(0, Number(row.stop_waiting_charge_pence ?? 0));
    if (rec.pre_promotion_commissionable_fare_pence != null) {
      commissionableTotal += rec.pre_promotion_commissionable_fare_pence;
    } else if (rec.driver_entitlement_pence != null && rec.gross_commission_pence != null) {
      commissionableTotal += rec.driver_entitlement_pence + rec.gross_commission_pence;
    }
    if (String(row.payout_reconciliation_status ?? "") === "PAYOUT_PAID") {
      payoutsCompleted += Math.max(0, Number(row.payout_amount_pence ?? 0));
    }

    if (rec.capture_variance_pence != null) {
      identityEvaluableCount += 1;
      identityVariance += rec.capture_variance_pence;
    } else {
      identityPendingCount += 1;
    }

    const cv = row.capture_variance_pence;
    const captureStatus = String(row.capture_reconciliation_status ?? "");
    if (
      captureStatus === "CAPTURE_SHORTFALL"
      || row.capture_classification === "CAPTURE_SHORTFALL"
      || row.capture_classification === "UNEXPLAINED_SHORTFALL"
    ) {
      if (cv != null && Number(cv) < 0) shortfall += Math.abs(Number(cv));
    }
    if (
      captureStatus === "OVERCAPTURE"
      || row.capture_classification === "UNEXPLAINED_OVERCAPTURE"
    ) {
      if (cv != null && Number(cv) > 0) overcapture += Number(cv);
    }

    if (
      captureStatus === "CAPTURE_MISSING"
      || captureStatus === "CAPTURE_PENDING"
      || captureStatus === "PAYMENT_SESSION_CAPTURE_MISMATCH"
      || rec.captured_amount_pence == null
    ) {
      missingCaptures += 1;
    }
    const releaseStatus = String(row.release_reconciliation_status ?? "");
    if (
      releaseStatus === "MISSING_RELEASE"
      || releaseStatus === "RELEASE_PENDING"
      || releaseStatus === "RELEASE_SHORTFALL"
      || releaseStatus === "RELEASE_AMOUNT_UNKNOWN"
    ) {
      missingReleases += 1;
    }
    if (releaseStatus === "RELEASE_AMOUNT_UNCONFIRMED") releaseUnconfirmed += 1;

    const walletStatus = String(rec.wallet_status ?? "");
    if (walletStatus === "WALLET_CREDIT_MISSING") missingWallet += 1;
    if (
      walletStatus === "WALLET_CREDIT_MISSING"
      || walletStatus === "WALLET_OVER_CREDITED"
      || walletStatus === "WALLET_UNDER_CREDITED"
      || walletStatus === "WALLET_DUPLICATE"
      || walletStatus === "WALLET_OVER_CREDIT"
      || walletStatus === "WALLET_UNDER_CREDIT"
      || walletStatus === "DUPLICATE_WALLET_CREDIT"
    ) {
      walletMismatch += 1;
    }
    if (
      String(row.payout_reconciliation_status ?? "") === "PAYOUT_MISMATCH"
      || String(row.payout_reconciliation_status ?? "") === "PAYOUT_FAILED"
      || String(row.payout_reconciliation_status ?? "") === "DUPLICATE_PAYOUT_RISK"
    ) {
      payoutMismatch += 1;
    }

    const fullyBalanced = isFrTripFullyBalanced({
      capture_reconciliation_status: captureStatus,
      release_reconciliation_status: releaseStatus,
      wallet_reconciliation_status: walletStatus,
      payout_reconciliation_status: String(row.payout_reconciliation_status ?? ""),
      fee_status: rec.provider_fee_status === "PENDING" ? "PENDING" : "CONFIRMED",
      settlement_identity_balanced: rec.capture_variance_pence === 0
        && rec.capture_variance_pence != null,
    });

    if (fullyBalanced) balanced += 1;

    if (rec.evaluable) {
      evaluated += 1;
      if (rec.final_reconciliation_status === FR_TRIP_AUDIT_STATUS.BALANCED) {
        matched += 1;
      } else if (
        rec.final_reconciliation_status === FR_TRIP_AUDIT_STATUS.CAPTURE_MISMATCH
        || rec.final_reconciliation_status === FR_TRIP_AUDIT_STATUS.WALLET_MISMATCH
        || rec.final_reconciliation_status === FR_TRIP_AUDIT_STATUS.PAYOUT_MISMATCH
        || rec.final_reconciliation_status === FR_TRIP_AUDIT_STATUS.PARTIAL
      ) {
        mismatched += 1;
      }
    } else {
      pending += 1;
    }

    if (!fullyBalanced && (
      row.capture_mismatch
      || captureStatus === "CAPTURE_SHORTFALL"
      || captureStatus === "OVERCAPTURE"
      || captureStatus === "CAPTURE_MISSING"
      || captureStatus === "PAYMENT_SESSION_CAPTURE_MISMATCH"
      || releaseStatus === "MISSING_RELEASE"
      || releaseStatus === "RELEASE_AMOUNT_UNCONFIRMED"
      || walletStatus === "WALLET_CREDIT_MISSING"
      || walletStatus === "WALLET_OVER_CREDITED"
      || walletStatus === "WALLET_UNDER_CREDITED"
      || walletStatus === "WALLET_DUPLICATE"
      || walletStatus === "WALLET_OVER_CREDIT"
      || walletStatus === "WALLET_UNDER_CREDIT"
      || walletStatus === "DUPLICATE_WALLET_CREDIT"
      || (rec.capture_variance_pence != null && rec.capture_variance_pence !== 0)
    )) {
      unresolved += 1;
    }
  }

  const identityBalanced = identityEvaluableCount > 0 && identityVariance === 0;

  return {
    completed_trip_fare_total_pence: fare,
    confirmed_provider_captured_total_pence: captured,
    total_authorised_pence: authorised,
    expected_released_pence: expectedReleased,
    released_total_pence: released,
    release_amount_unconfirmed_count: releaseUnconfirmed,
    refunded_total_pence: refunded,
    waiting_charges_total_pence: waitingTotal,
    provider_fee_total_pence: confirmedFees,
    provider_fee_pending_total_pence: pendingFees,
    onecab_gross_commission_pence: gross,
    onecab_net_commission_pence: netKnown ? netSum : null,
    driver_net_total_pence: driverNet,
    wallet_credits_total_pence: walletCredits,
    payouts_completed_pence: payoutsCompleted,
    airport_charges_total_pence: airportTotal,
    driver_tips_total_pence: tipsTotal,
    commissionable_fare_total_pence: commissionableTotal,
    settlement_identity_variance_pence: identityEvaluableCount > 0 ? identityVariance : null,
    settlement_identity_balanced: identityBalanced,
    settlement_identity_evaluable_trip_count: identityEvaluableCount,
    settlement_identity_pending_trip_count: identityPendingCount,
    unallocated_pence: identityEvaluableCount > 0 ? identityVariance : null,
    capture_shortfall_pence: shortfall,
    overcapture_pence: overcapture,
    missing_captures_count: missingCaptures,
    missing_releases_count: missingReleases,
    missing_wallet_credits_count: missingWallet,
    payout_mismatches_count: payoutMismatch,
    wallet_mismatches_count: walletMismatch,
    balanced_trips_count: balanced,
    unresolved_mismatches_count: unresolved,
    trip_count: records.length,
    evaluated_trip_count: evaluated,
    pending_trip_count: pending,
    matched_trip_count: matched,
    mismatched_trip_count: mismatched,
  };
}

export function buildFrPeriodAuditSummary(
  records: FrPerTripAuditRecord[],
): FrPeriodAuditSummary {
  const pendingTrips = records
    .filter((r) => !r.evaluable && r.pending_reason)
    .map((r) => ({
      trip_id: r.trip_id,
      trip_code: r.trip_code,
      pending_reason: r.pending_reason!,
    }));

  const walletGapTrips = records
    .filter((r) => {
      const ws = r.wallet_status;
      return ws === "WALLET_CREDIT_MISSING"
        || ws === "WALLET_UNDER_CREDITED"
        || ws === "WALLET_UNDER_CREDIT"
        || ws === "WALLET_OVER_CREDITED"
        || ws === "WALLET_OVER_CREDIT"
        || ws === "WALLET_DUPLICATE"
        || ws === "DUPLICATE_WALLET_CREDIT";
    })
    .map((r) => ({
      trip_id: r.trip_id,
      trip_code: r.trip_code,
      expected_driver_entitlement_pence: r.driver_entitlement_pence ?? 0,
      actual_trip_earning_net_pence: r.actual_trip_earning_net_pence ?? 0,
      wallet_variance_pence: r.wallet_variance_pence ?? 0,
      wallet_status: String(r.wallet_status ?? "UNKNOWN"),
    }));

  const walletGapTotal = walletGapTrips.reduce(
    (s, t) => s + Math.abs(t.wallet_variance_pence),
    0,
  );

  let evaluated = 0;
  let pending = 0;
  let matched = 0;
  let mismatched = 0;
  for (const r of records) {
    if (r.evaluable) {
      evaluated += 1;
      if (r.final_reconciliation_status === FR_TRIP_AUDIT_STATUS.BALANCED) matched += 1;
      else if (
        r.final_reconciliation_status !== FR_TRIP_AUDIT_STATUS.PENDING_SYNC
        && r.final_reconciliation_status !== FR_TRIP_AUDIT_STATUS.PROVIDER_EVIDENCE_PENDING
        && r.final_reconciliation_status !== FR_TRIP_AUDIT_STATUS.UNAVAILABLE
      ) {
        mismatched += 1;
      }
    } else {
      pending += 1;
    }
  }

  return {
    evaluated_trip_count: evaluated,
    pending_trip_count: pending,
    matched_trip_count: matched,
    mismatched_trip_count: mismatched,
    pending_trips: pendingTrips,
    wallet_gap_total_pence: walletGapTotal,
    wallet_gap_trips: walletGapTrips,
  };
}
