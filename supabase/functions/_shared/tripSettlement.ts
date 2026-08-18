/**
 * Trip settlement — SINGLE SOURCE OF TRUTH for commission / driver net / platform revenue.
 *
 * All settlement writers (trip complete, negotiation accept, admin fare edit, provider
 * webhook recovery, capture) must use calculateTripSettlement().
 *
 * Formula v2 / Slice 4 (waiting commissionable):
 *   commissionable = final_fare − airport_charge
 *   (waiting / stop waiting / commissionable extras stay inside final_fare)
 *   Non-commissionable ONLY: airport charges + driver tips
 *   tips are usually outside final_fare and added to driver_total only
 *
 * global_offer (this feature, no waiting in this path):
 *   commissionable = fare_snapshot_json.gross_fare_pence|locked_base_fare_pence
 *                  + customer_modification_charge_pence
 *   gross commission on that base; locked offer_discount_pence deducted from ONECAB only
 *
 * Explicit component API + golden fixtures: shared/canonicalSettlementSSOT.ts
 * Identity: captured = driver_net + gross_commission + airport + tips
 * Provider fee reduces ONECAB net only (never driver_net).
 */

export const SETTLEMENT_FORMULA_VERSION = "2";

/** Sanity ceiling for commission % (wave/base rates may exceed legacy 15% tier caps). */
export const MAX_COMMISSION_PERCENT = 100;

export type TripSettlementInput = {
  /** Customer trip fare including waiting and commissionable extras; tips usually excluded. */
  final_fare_pence: number;
  airport_charge_pence?: number;
  /**
   * @deprecated v2 — pass-through is commissionable when inside final_fare.
   * Kept for call-site compat; ignored for commissionable math.
   */
  other_pass_through_charges_pence?: number;
  tips_pence?: number;
  driver_tier_commission_percent: number;
  provider_fee_pence?: number;
  /** When false, ONECAB net is PENDING even if a fee number is present. */
  provider_fee_confirmed?: boolean;
  /** Locked global_offer amount (`offer_discount_pence`). Deducted from ONECAB only. */
  locked_promotion_pence?: number;
  /**
   * Pre-promotion commissionable base. When set, used instead of final_fare − airport.
   * Must be original ride + full-price modifications — never snapshot+gross double-count.
   */
  pre_promotion_commissionable_fare_pence?: number;
};

export type TripSettlementResult = {
  final_fare_pence: number;
  commissionable_fare_pence: number;
  commission_pence: number;
  locked_promotion_pence: number;
  /**
   * Promotion absorbed by ONECAB (deducted from commission).
   * Equals locked_promotion_pence when applied; 0 when the promotion reduces the customer fare
   * instead of being absorbed by ONECAB commission.
   * In the canonical formula, applied_customer_promotion_pence = locked_promotion_pence always
   * because ONECAB funds the global_offer discount from commission.
   */
  applied_customer_promotion_pence: number;
  /**
   * Gross commission minus applied customer promotion.
   * May be negative when promotion exceeds commission — preserved as explicit ONECAB subsidy.
   * Never reduces driver_net_pence.
   */
  commission_after_promotion_pence: number;
  driver_net_pence: number;
  driver_total_earnings_pence: number;
  airport_charge_pence: number;
  other_pass_through_charges_pence: number;
  tips_pence: number;
  provider_fee_pence: number;
  provider_fee_confirmed: boolean;
  platform_gross_revenue_pence: number;
  platform_net_revenue_pence: number;
  /** Null when provider fee is unconfirmed — never invent £0. Negative nets are preserved. */
  onecab_net_pence: number | null;
  tier_percent_used: number;
  formula_version: string;
};

export type TripSettlementTripRow = {
  final_fare_pence?: number | null;
  capture_amount_pence?: number | null;
  final_customer_fare_pence?: number | null;
  pickup_waiting_charge_pence?: number | null;
  stop_waiting_charge_pence?: number | null;
  total_waiting_charge_pence?: number | null;
  waiting_charge_pence?: number | null;
  airport_charge_pence?: number | null;
  other_pass_through_charges_pence?: number | null;
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
  accepted_commission_percent?: number | null;
  driver_tier_commission_percent?: number | null;
  commission_pct?: number | null;
  driver_net_pence?: number | null;
  provider_fee_pence?: number | null;
  fare_snapshot_json?: Record<string, unknown> | null;
  locked_base_fare_pence?: number | null;
  offer_discount_pence?: number | null;
  discount_source?: string | null;
  customer_modification_charge_pence?: number | null;
  locked_offer_type?: string | null;
  accepted_driver_offer_fare_pence?: number | null;
};

function nonNegInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

export function capTierCommissionPercent(percent: number): number {
  const n = Number(percent);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_COMMISSION_PERCENT, n);
}

/** Prior global_offer is audit-only after driver/customer negotiated fare acceptance. */
export function isPromotionSupersededByNegotiation(trip: TripSettlementTripRow): boolean {
  if (trip.locked_offer_type === "negotiated_offer") return true;
  const snap = trip.fare_snapshot_json;
  if (!snap || typeof snap !== "object") return false;
  if (snap.promotion_application_status === "SUPERSEDED_BY_NEGOTIATION") return true;
  const fareSource = snap.fare_source;
  return fareSource === "negotiated" || fareSource === "negotiated_offer";
}

/** Locked ONECAB-funded promotion — existing `offer_discount_pence` when source is global_offer. */
export function resolveLockedPromotionPence(trip: TripSettlementTripRow): number {
  if (isPromotionSupersededByNegotiation(trip)) return 0;
  const src = typeof trip.discount_source === "string" ? trip.discount_source : "";
  if (src !== "global_offer") return 0;
  return nonNegInt(trip.offer_discount_pence);
}

/** Audit-only prior promotion when negotiation superseded global_offer. */
export function resolvePreviousLockedPromotionPence(trip: TripSettlementTripRow): number {
  const snap = trip.fare_snapshot_json;
  if (snap && typeof snap === "object") {
    const fromSnap = nonNegInt(snap.previous_locked_promotion_pence);
    if (fromSnap > 0) return fromSnap;
  }
  const src = typeof trip.discount_source === "string" ? trip.discount_source : "";
  if (src !== "global_offer") return 0;
  return nonNegInt(trip.offer_discount_pence);
}

/**
 * Original pre-promotion fare from snapshot.
 * Prefers the explicit `original_fare_pence` stamp (most semantically precise),
 * then `gross_fare_pence` (pre-modification fare at booking lock time).
 * Never uses `final_fare_pence` from snapshot (post-discount).
 */
function snapshotGrossFarePence(trip: TripSettlementTripRow): number {
  const snap = trip.fare_snapshot_json;
  if (!snap || typeof snap !== "object") return 0;
  // original_fare_pence is the authoritative pre-promotion original ride price.
  const original = nonNegInt(snap.original_fare_pence);
  if (original > 0) return original;
  return nonNegInt(snap.gross_fare_pence);
}

/**
 * Original pre-promotion ride fare from the booking snapshot, else locked_base.
 * Never uses trips.gross_fare_pence (may already include modifications).
 */
export function resolveOriginalPrePromotionRideFarePence(trip: TripSettlementTripRow): number {
  return snapshotGrossFarePence(trip) || nonNegInt(trip.locked_base_fare_pence);
}

/**
 * global_offer commissionable base: original ride + full-price modifications.
 * Does not add waiting (separate workflow). Does not add gross_fare_pence.
 */
export function resolveNegotiatedCommissionableFarePence(trip: TripSettlementTripRow): number {
  const snap = trip.fare_snapshot_json;
  const negotiated = nonNegInt(snap?.negotiated_commissionable_fare_pence)
    || nonNegInt(trip.accepted_driver_offer_fare_pence)
    || nonNegInt(snap?.negotiated_fare_pence)
    || nonNegInt(trip.final_fare_pence);
  if (negotiated <= 0) return 0;
  return negotiated + nonNegInt(trip.customer_modification_charge_pence);
}

export function resolvePrePromotionCommissionableFarePence(trip: TripSettlementTripRow): number {
  if (isPromotionSupersededByNegotiation(trip)) {
    return resolveNegotiatedCommissionableFarePence(trip);
  }
  const original = resolveOriginalPrePromotionRideFarePence(trip);
  if (original <= 0) return 0;
  return original + nonNegInt(trip.customer_modification_charge_pence);
}

/** True when global_offer exists but authoritative pre-promotion evidence is absent. */
export function isPrePromotionFareEvidenceMissing(trip: TripSettlementTripRow): boolean {
  if (isPromotionSupersededByNegotiation(trip)) return false;
  const src = typeof trip.discount_source === "string" ? trip.discount_source : "";
  if (src !== "global_offer") return false;
  if (nonNegInt(trip.offer_discount_pence) <= 0) return false;
  return resolveOriginalPrePromotionRideFarePence(trip) <= 0;
}

/**
 * Resolve the fare base that must include waiting when present.
 * Prefer capture → final_fare → final_customer + waiting.
 */
export function resolveSettlementFinalFarePence(trip: TripSettlementTripRow): number {
  const capture = nonNegInt(trip.capture_amount_pence);
  const tips = nonNegInt(trip.tip_pence ?? trip.tip_amount_pence);
  const captureFare = capture > 0 ? Math.max(0, capture - tips) : 0;
  const finalFare = nonNegInt(trip.final_fare_pence);
  const waiting =
    nonNegInt(trip.pickup_waiting_charge_pence)
    + nonNegInt(trip.stop_waiting_charge_pence)
    || nonNegInt(trip.total_waiting_charge_pence)
    || nonNegInt(trip.waiting_charge_pence);
  const customerPlusWaiting = nonNegInt(trip.final_customer_fare_pence) + waiting;
  return Math.max(captureFare, finalFare, customerPlusWaiting);
}

/**
 * Canonical settlement formula owner (v2).
 * Waiting must already be inside final_fare_pence (or resolved via resolveSettlementFinalFarePence)
 * unless pre_promotion_commissionable_fare_pence is supplied (global_offer path — no waiting).
 */
export function calculateTripSettlement(input: TripSettlementInput): TripSettlementResult {
  const finalFarePence = nonNegInt(input.final_fare_pence);
  const airportChargePence = nonNegInt(input.airport_charge_pence);
  const otherPassThroughChargesPence = 0;
  const tipsPence = nonNegInt(input.tips_pence);
  const feePending = input.provider_fee_confirmed === false;
  const providerFeePence = feePending ? 0 : nonNegInt(input.provider_fee_pence);
  const providerFeeConfirmed = !feePending
    && (input.provider_fee_confirmed === true || providerFeePence > 0);
  const tierPercentUsed = capTierCommissionPercent(input.driver_tier_commission_percent);
  const lockedPromotionPence = nonNegInt(input.locked_promotion_pence);

  const commissionableFarePence = input.pre_promotion_commissionable_fare_pence != null
    ? Math.max(0, nonNegInt(input.pre_promotion_commissionable_fare_pence))
    : Math.max(0, finalFarePence - airportChargePence);

  const commissionPence = Math.round((commissionableFarePence * tierPercentUsed) / 100);
  const driverNetPence = Math.max(0, commissionableFarePence - commissionPence);
  const driverTotalEarningsPence = driverNetPence + airportChargePence + tipsPence;
  // The applied customer promotion is always the full locked promotion (ONECAB funds it from commission).
  // Customer modifications are full-price and receive no promotion.
  const appliedCustomerPromotionPence = lockedPromotionPence;
  // commission_after_promotion may be negative (explicit ONECAB subsidy) — never clamped.
  // driver_net is never reduced by the promotion.
  const commissionAfterPromotionPence = commissionPence - appliedCustomerPromotionPence;
  const onecabNetPence = feePending
    ? null
    : commissionAfterPromotionPence - providerFeePence;

  const platformGrossRevenuePence = commissionPence;
  const platformNetRevenuePence = onecabNetPence ?? 0;

  return {
    final_fare_pence: finalFarePence,
    commissionable_fare_pence: commissionableFarePence,
    commission_pence: commissionPence,
    locked_promotion_pence: lockedPromotionPence,
    applied_customer_promotion_pence: appliedCustomerPromotionPence,
    commission_after_promotion_pence: commissionAfterPromotionPence,
    driver_net_pence: driverNetPence,
    driver_total_earnings_pence: driverTotalEarningsPence,
    airport_charge_pence: airportChargePence,
    other_pass_through_charges_pence: otherPassThroughChargesPence,
    tips_pence: tipsPence,
    provider_fee_pence: providerFeePence,
    provider_fee_confirmed: providerFeeConfirmed,
    platform_gross_revenue_pence: platformGrossRevenuePence,
    platform_net_revenue_pence: platformNetRevenuePence,
    onecab_net_pence: onecabNetPence,
    tier_percent_used: tierPercentUsed,
    formula_version: SETTLEMENT_FORMULA_VERSION,
  };
}

/** Resolve commission % from a persisted trip row (accepted wave snapshot first). */
export function resolveTripTierPercent(trip: TripSettlementTripRow): number {
  const accepted = trip.accepted_commission_percent;
  if (accepted != null && Number.isFinite(Number(accepted))) {
    return capTierCommissionPercent(Number(accepted));
  }
  const pct = trip.driver_tier_commission_percent ?? trip.commission_pct ?? 0;
  return capTierCommissionPercent(pct);
}

/**
 * Settlement identity (pence):
 * captured = driver_net + gross_commission + airport + tips
 */
export function assertSettlementCaptureIdentity(args: {
  captured_pence: number;
  driver_net_pence: number;
  commission_pence: number;
  airport_charge_pence: number;
  tips_pence: number;
}): { balanced: boolean; variance_pence: number } {
  const rhs =
    Math.max(0, args.driver_net_pence)
    + Math.max(0, args.commission_pence)
    + Math.max(0, args.airport_charge_pence)
    + Math.max(0, args.tips_pence);
  const variance = Math.max(0, args.captured_pence) - rhs;
  return { balanced: variance === 0, variance_pence: variance };
}

/**
 * Build the trip row used for post-capture / completion settlement.
 * Waiting must remain inside the fare base (never settle from ride-only final_customer).
 */
export function buildSettlementTripRow(args: {
  trip: TripSettlementTripRow & { provider_fee_pence?: number | null };
  captureAmountPence?: number | null;
  tipPence?: number;
  finalFarePence?: number | null;
  pickupWaitingChargePence?: number | null;
  stopWaitingChargePence?: number | null;
}): TripSettlementTripRow {
  const tip = nonNegInt(args.tipPence ?? args.trip.tip_pence ?? args.trip.tip_amount_pence);
  return {
    ...args.trip,
    capture_amount_pence: args.captureAmountPence == null
      ? args.trip.capture_amount_pence
      : args.captureAmountPence,
    tip_pence: tip,
    tip_amount_pence: tip,
    final_fare_pence: args.finalFarePence == null
      ? args.trip.final_fare_pence
      : args.finalFarePence,
    pickup_waiting_charge_pence: args.pickupWaitingChargePence == null
      ? args.trip.pickup_waiting_charge_pence
      : args.pickupWaitingChargePence,
    stop_waiting_charge_pence: args.stopWaitingChargePence == null
      ? args.trip.stop_waiting_charge_pence
      : args.stopWaitingChargePence,
  };
}

/**
 * Card wallet TRIP_EARNING_NET = commissionable net + airport.
 * Tips stay on DRIVER_TIP_CREDIT. Provider fee never enters this amount.
 */
export function resolveCapturedTripEarningNetPence(args: {
  trip: TripSettlementTripRow & { provider_fee_pence?: number | null };
  captureAmountPence: number;
  tipPence?: number;
}): {
  driverNetPence: number;
  commissionPct: number;
  tipPence: number;
  settlement: TripSettlementResult | null;
} {
  const row = buildSettlementTripRow({
    trip: args.trip,
    captureAmountPence: args.captureAmountPence,
    tipPence: args.tipPence,
  });
  const settlement = calculateTripSettlementFromTripRow(
    row,
    nonNegInt(args.trip.provider_fee_pence),
  );
  if (settlement) {
    return {
      driverNetPence: settlement.driver_net_pence + settlement.airport_charge_pence,
      commissionPct: settlement.tier_percent_used,
      tipPence: settlement.tips_pence,
      settlement,
    };
  }
  return {
    driverNetPence: nonNegInt(args.trip.driver_net_pence) + nonNegInt(args.trip.airport_charge_pence),
    commissionPct: resolveTripTierPercent(row),
    tipPence: nonNegInt(args.tipPence ?? args.trip.tip_pence ?? args.trip.tip_amount_pence),
    settlement: null,
  };
}

/** Settlement from persisted trip fare columns (webhook recovery, capture). */
export function calculateTripSettlementFromTripRow(
  trip: TripSettlementTripRow,
  providerFeePence = 0,
  options?: { provider_fee_confirmed?: boolean },
): TripSettlementResult | null {
  if (isPrePromotionFareEvidenceMissing(trip)) {
    return null;
  }

  const lockedPromotionPence = resolveLockedPromotionPence(trip);
  const prePromotionCommissionable = resolvePrePromotionCommissionableFarePence(trip);

  if (lockedPromotionPence > 0 && prePromotionCommissionable > 0) {
    const airport = nonNegInt(trip.airport_charge_pence);
    return calculateTripSettlement({
      final_fare_pence: prePromotionCommissionable + airport,
      pre_promotion_commissionable_fare_pence: prePromotionCommissionable,
      locked_promotion_pence: lockedPromotionPence,
      airport_charge_pence: airport,
      tips_pence: trip.tip_pence ?? trip.tip_amount_pence ?? 0,
      driver_tier_commission_percent: resolveTripTierPercent(trip),
      provider_fee_pence: providerFeePence || nonNegInt(trip.provider_fee_pence),
      provider_fee_confirmed: options?.provider_fee_confirmed,
    });
  }

  const finalFarePence = resolveSettlementFinalFarePence(trip);
  if (finalFarePence <= 0) return null;

  return calculateTripSettlement({
    final_fare_pence: finalFarePence,
    airport_charge_pence: trip.airport_charge_pence ?? 0,
    tips_pence: trip.tip_pence ?? trip.tip_amount_pence ?? 0,
    driver_tier_commission_percent: resolveTripTierPercent(trip),
    provider_fee_pence: providerFeePence,
    provider_fee_confirmed: options?.provider_fee_confirmed,
  });
}

/** DB columns to persist when settlement is finalized. Existing columns only. */
export function tripSettlementDbColumns(
  settlement: TripSettlementResult,
): Record<string, number | string | null> {
  return {
    final_fare_pence: settlement.final_fare_pence,
    commissionable_fare_pence: settlement.commissionable_fare_pence,
    commission_pence: settlement.commission_pence,
    driver_net_pence: settlement.driver_net_pence,
    driver_net_before_tip_pence: settlement.driver_net_pence,
    driver_total_earnings_pence: settlement.driver_total_earnings_pence,
    airport_charge_pence: settlement.airport_charge_pence,
    tip_pence: settlement.tips_pence,
    tip_amount_pence: settlement.tips_pence,
    commission_pct: settlement.tier_percent_used,
    driver_tier_commission_percent: settlement.tier_percent_used,
    gross_fare_pence: settlement.commissionable_fare_pence,
    provider_fee_pence: settlement.provider_fee_confirmed ? settlement.provider_fee_pence : null,
    onecab_net_pence: settlement.onecab_net_pence,
    platform_gross_revenue_pence: settlement.platform_gross_revenue_pence,
    platform_net_revenue_pence: settlement.onecab_net_pence,
    settlement_formula_version: settlement.formula_version,
  };
}

/** Merge settlement snapshot keys onto an existing fare_snapshot_json object. */
export function mergeFareSnapshotSettlementJson(
  existing: Record<string, unknown> | null | undefined,
  settlement: TripSettlementResult,
): Record<string, unknown> {
  return {
    ...(existing && typeof existing === "object" ? existing : {}),
    ...tripSettlementSnapshotJson(settlement),
  };
}

/** fare_snapshot_json settlement keys (never drop values when columns missing). */
export function tripSettlementSnapshotJson(
  settlement: TripSettlementResult,
): Record<string, number | string | null> {
  return {
    settlement_formula_version: settlement.formula_version,
    commissionable_fare_pence: settlement.commissionable_fare_pence,
    commission_pence: settlement.commission_pence,
    locked_promotion_pence: settlement.locked_promotion_pence,
    applied_customer_promotion_pence: settlement.applied_customer_promotion_pence,
    commission_after_promotion_pence: settlement.commission_after_promotion_pence,
    driver_net_pence: settlement.driver_net_pence,
    driver_total_earnings_pence: settlement.driver_total_earnings_pence,
    platform_gross_revenue_pence: settlement.platform_gross_revenue_pence,
    platform_net_revenue_pence: settlement.platform_net_revenue_pence,
    onecab_net_pence: settlement.onecab_net_pence,
    provider_fee_pence: settlement.provider_fee_confirmed ? settlement.provider_fee_pence : null,
    tier_percent_used: settlement.tier_percent_used,
  };
}
