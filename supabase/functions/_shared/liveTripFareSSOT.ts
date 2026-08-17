/**
 * Live active-trip fare preview SSOT (not settlement / capture).
 *
 * current_customer_total_pence =
 *   confirmed_fare_pence
 *   + pickup_waiting_charge_pence
 *   + stop_waiting_charge_pence
 *   + approved_modification_delta_pence (only when not already folded into confirmed fare)
 *
 * driver_net_preview_pence = round(current_customer_total_pence × (1 − commission_percent/100))
 */

export type LiveTripFareInput = {
  final_customer_fare_pence?: number | null;
  final_fare_pence?: number | null;
  locked_base_fare_pence?: number | null;
  pickup_waiting_charge_pence?: number | null;
  stop_waiting_charge_pence?: number | null;
  stop_charge_total_pence?: number | null;
  customer_modification_charge_pence?: number | null;
  modification_delta_pence?: number | null;
  accepted_commission_percent?: number | null;
  driver_tier_commission_percent?: number | null;
  commission_pct?: number | null;
  commission_pence?: number | null;
  gross_fare_pence?: number | null;
  offer_discount_pence?: number | null;
  discount_pence?: number | null;
};

export type LiveTripFarePreview = {
  final_customer_fare_pence: number;
  pickup_waiting_charge_pence: number;
  stop_waiting_charge_pence: number;
  approved_modification_delta_pence: number;
  current_customer_total_pence: number;
  driver_net_preview_pence: number;
  commission_percent: number;
};

function nonNeg(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/** Signed pence (mods may be negative after a shorter destination). */
function signedPence(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/**
 * Prefer cumulative customer_modification_charge_pence (signed SSOT from apply).
 * Never coerce negatives through nonNeg — that fell through to the last positive
 * modification_delta_pence and re-added it on top of an already-folded final
 * (MK-260816-004: 679 + 266 = 945).
 */
function resolveModificationStoredPence(trip: LiveTripFareInput): {
  modStored: number;
  cumulativePresent: boolean;
} {
  const cumulative = signedPence(trip.customer_modification_charge_pence);
  if (
    trip.customer_modification_charge_pence !== null &&
    trip.customer_modification_charge_pence !== undefined &&
    cumulative != null
  ) {
    return { modStored: cumulative, cumulativePresent: true };
  }
  return {
    modStored: signedPence(trip.modification_delta_pence) ?? 0,
    cumulativePresent: false,
  };
}

function normalizeCommissionPercent(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return 0;
  // Accept either 15 (percent) or 0.15 (fraction).
  const pct = raw > 0 && raw <= 1 ? raw * 100 : raw;
  return Math.min(100, pct);
}

function resolveCommissionPercent(trip: LiveTripFareInput): number {
  const accepted = Number(trip.accepted_commission_percent);
  if (Number.isFinite(accepted) && accepted >= 0) return normalizeCommissionPercent(accepted);

  const tier = Number(trip.driver_tier_commission_percent);
  if (Number.isFinite(tier) && tier >= 0) return normalizeCommissionPercent(tier);

  const pct = Number(trip.commission_pct);
  if (Number.isFinite(pct) && pct >= 0) return normalizeCommissionPercent(pct);

  const commission = Number(trip.commission_pence);
  const gross = Number(trip.gross_fare_pence);
  if (Number.isFinite(commission) && commission >= 0 && Number.isFinite(gross) && gross > 0) {
    return normalizeCommissionPercent(commission / gross);
  }

  return 0;
}

/** Confirmed booking payable (excludes live waiting). */
export function resolveConfirmedCustomerFarePence(trip: LiveTripFareInput): number {
  return (
    nonNeg(trip.final_customer_fare_pence) ||
    nonNeg(trip.final_fare_pence) ||
    nonNeg(trip.locked_base_fare_pence)
  );
}

/**
 * Mod delta may be added to live preview only with positive pre-fold proof.
 * When a canonical committed fare is present, stored modification is audit history
 * unless the payable is still at/below locked ride base (mod not yet folded).
 */
export function resolveApprovedModificationDeltaPence(args: {
  confirmedFare: number;
  modStored: number;
  lockedBase: number;
  grossFare: number;
  discountPence: number;
}): number {
  const { confirmedFare, modStored, lockedBase, grossFare, discountPence } = args;

  if (modStored === 0) return 0;
  if (confirmedFare <= 0) return modStored;

  // Pre-fold: positive mod pending while payable remains at/below locked ride base.
  if (modStored > 0 && lockedBase > 0 && confirmedFare <= lockedBase) {
    return modStored;
  }

  // Metadata-backed fold proof when committed fare exceeds locked base.
  if (lockedBase > 0) {
    let foldBasis = grossFare > 0 ? grossFare : confirmedFare;
    // Net-only gross after fold (MK-260817-005): reconstruct pre-discount once for detection.
    if (
      discountPence > 0 &&
      foldBasis > 0 &&
      foldBasis < lockedBase + modStored - 1 &&
      foldBasis + discountPence >= lockedBase + modStored - 1
    ) {
      foldBasis = foldBasis + discountPence;
    }
    if (foldBasis >= lockedBase + modStored - 1) {
      return 0;
    }
    if (
      discountPence > 0 &&
      confirmedFare >= lockedBase + modStored - discountPence - 1
    ) {
      return 0;
    }
    if (
      grossFare > 0 &&
      grossFare === confirmedFare &&
      confirmedFare > lockedBase
    ) {
      return 0;
    }
  }

  // Committed canonical fare — modification is audit-only (never default final + mod).
  return 0;
}

/**
 * Live customer total + driver net preview for active / uncaptured trips.
 * Does not mutate settlement columns or capture amounts.
 */
export function computeLiveTripFarePreview(trip: LiveTripFareInput): LiveTripFarePreview {
  const confirmedFare = resolveConfirmedCustomerFarePence(trip);
  const pickupWaiting = nonNeg(trip.pickup_waiting_charge_pence);
  const stopWaiting =
    nonNeg(trip.stop_waiting_charge_pence) || nonNeg(trip.stop_charge_total_pence);
  const { modStored } = resolveModificationStoredPence(trip);
  const lockedBase = nonNeg(trip.locked_base_fare_pence);
  const grossFare = nonNeg(trip.gross_fare_pence);
  const discountPence =
    nonNeg(trip.offer_discount_pence) || nonNeg(trip.discount_pence);

  const approvedModificationDelta = resolveApprovedModificationDeltaPence({
    confirmedFare,
    modStored,
    lockedBase,
    grossFare,
    discountPence,
  });

  const currentCustomerTotalPence = Math.max(
    1,
    confirmedFare + pickupWaiting + stopWaiting + approvedModificationDelta,
  );

  const commissionPercent = resolveCommissionPercent(trip);
  const driverNetPreviewPence = Math.round(
    currentCustomerTotalPence * (1 - commissionPercent / 100),
  );

  return {
    final_customer_fare_pence: confirmedFare,
    pickup_waiting_charge_pence: pickupWaiting,
    stop_waiting_charge_pence: stopWaiting,
    approved_modification_delta_pence: approvedModificationDelta,
    current_customer_total_pence: currentCustomerTotalPence,
    driver_net_preview_pence: Math.max(0, driverNetPreviewPence),
    commission_percent: commissionPercent,
  };
}

const CAPTURED_PAYMENT_STATUSES = new Set([
  "captured",
  "paid",
  "partially_paid",
  "partially_refunded",
  "refunded",
  "settled",
]);

/** True when trip is still live for fare preview (not yet captured/settled). */
export function isUncapturedActivePaymentStatus(
  paymentStatus: string | null | undefined,
): boolean {
  const s = (paymentStatus ?? "").trim().toLowerCase();
  if (!s) return true;
  return !CAPTURED_PAYMENT_STATUSES.has(s);
}
