/**
 * Financial display SSOT — Request Ride confirmed fare is immutable for base ride fare.
 * All customer/driver/admin surfaces MUST use resolveTripDisplayFare().
 *
 * Priority (payable / commission base at booking):
 *   final_customer_fare_pence → final_fare_pence → estimated_total_pence
 *   → gross_fare_pence - discount → gross_fare_pence
 */

export const BOOKING_PRICING_VERSION = "booking_financial_v1" as const;

export type DiscountSource = "personal_voucher" | "global_offer" | null;

export type TripDisplayFareRow = {
  final_customer_fare_pence?: number | null;
  final_fare_pence?: number | null;
  estimated_total_pence?: number | null;
  capture_amount_pence?: number | null;
  gross_fare_pence?: number | null;
  offer_discount_pence?: number | null;
  voucher_discount_pence?: number | null;
  promotion_discount_pence?: number | null;
  discount_pence?: number | null;
  discount_source?: string | null;
  fare?: number | null;
  estimated_fare?: number | null;
  fare_snapshot_json?: Record<string, unknown> | null;
  /** Post-lock adjustments — excluded from booking payable resolver */
  pickup_waiting_charge_pence?: number | null;
  stop_waiting_charge_pence?: number | null;
  stop_charge_total_pence?: number | null;
  total_waiting_charge_pence?: number | null;
  customer_modification_charge_pence?: number | null;
  airport_charge_pence?: number | null;
  fare_locked?: boolean | null;
};

export type TripDisplayFareSource =
  | "final_customer_fare_pence"
  | "final_fare_pence"
  | "estimated_total_pence"
  | "gross_minus_discount"
  | "gross_fare_pence"
  | "fare_column"
  | "none";

export type ResolvedTripDisplayFare = {
  /** Customer-visible base ride fare (pence) — commission base at booking */
  payable_pence: number;
  payable_major: number;
  /** Original pre-discount fare (audit only) */
  original_pence: number | null;
  original_major: number | null;
  discount_pence: number;
  commission_base_pence: number;
  source: TripDisplayFareSource;
};

export type BookingFarePersistInput = {
  grossFarePence: number;
  finalPayableFarePence: number;
  offerDiscountPence?: number;
  voucherDiscountPence?: number;
  discountSource?: DiscountSource;
  appliedOfferId?: string | null;
  appliedPersonalVoucherId?: string | null;
  appliedPersonalVoucherCode?: string | null;
  pricingSource?: string;
};

export type BookingFinancialSnapshot = {
  gross_fare_pence: number;
  offer_discount_pence: number;
  voucher_discount_pence: number;
  discount_pence: number;
  discount_source: DiscountSource;
  final_fare_pence: number;
  final_customer_fare_pence: number;
  estimated_total_pence: number;
  fare_major: number;
  estimated_fare_major: number;
  pricing_version: string;
  pricing_source: string;
  created_pricing_hash: string;
  fare_snapshot_json: Record<string, unknown>;
};

export class BookingFinancialSnapshotError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BookingFinancialSnapshotError";
  }
}

function nonNeg(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

function majorFromPence(pence: number): number {
  return pence / 100;
}

function snapshotPence(
  snap: Record<string, unknown> | null | undefined,
  key: string,
): number {
  return nonNeg(snap?.[key]);
}

export function resolveDiscountPenceFromTrip(trip: TripDisplayFareRow): number {
  const explicit = nonNeg(trip.discount_pence);
  if (explicit > 0) return explicit;

  const source = trip.discount_source;
  if (source === "personal_voucher") return nonNeg(trip.voucher_discount_pence);
  if (source === "global_offer") {
    return nonNeg(trip.offer_discount_pence) || nonNeg(trip.promotion_discount_pence);
  }

  return Math.max(
    nonNeg(trip.offer_discount_pence),
    nonNeg(trip.voucher_discount_pence),
    nonNeg(trip.promotion_discount_pence),
  );
}

export function resolveOriginalFarePence(trip: TripDisplayFareRow): number | null {
  const gross = nonNeg(trip.gross_fare_pence);
  if (gross > 0) return gross;
  const snap = trip.fare_snapshot_json;
  if (snap && typeof snap === "object") {
    const fromSnap = nonNeg(snap.gross_fare_pence);
    if (fromSnap > 0) return fromSnap;
  }
  return null;
}

/** Single fare resolver — NO independent fare math allowed downstream. */
export function resolveTripDisplayFare(trip: TripDisplayFareRow): ResolvedTripDisplayFare {
  const discount = resolveDiscountPenceFromTrip(trip);
  const original = resolveOriginalFarePence(trip);
  const snap = trip.fare_snapshot_json;

  const snapPayable =
    snapshotPence(snap, "final_customer_fare_pence") ||
    snapshotPence(snap, "canonical_payable_fare_pence") ||
    snapshotPence(snap, "final_payable_fare_pence") ||
    snapshotPence(snap, "fare_after_discount_pence");

  let payable = 0;
  let source: TripDisplayFareSource = "none";

  const finalCustomer = nonNeg(trip.final_customer_fare_pence);
  if (finalCustomer > 0) {
    payable = finalCustomer;
    source = "final_customer_fare_pence";
  } else if (snapPayable > 0) {
    payable = snapPayable;
    source = "final_customer_fare_pence";
  } else {
    const finalFare = nonNeg(trip.final_fare_pence);
    if (finalFare > 0) {
      payable = finalFare;
      source = "final_fare_pence";
      if (discount > 0 && original != null && finalFare === original) {
        payable = Math.max(0, finalFare - discount);
        source = "gross_minus_discount";
      }
    } else {
      const estimatedTotal = nonNeg(trip.estimated_total_pence);
      if (estimatedTotal > 0) {
        payable = estimatedTotal;
        source = "estimated_total_pence";
      } else if (original != null && discount > 0) {
        payable = Math.max(0, original - discount);
        source = "gross_minus_discount";
      } else if (original != null) {
        payable = original;
        source = "gross_fare_pence";
      } else {
        const fareMajor = Number(trip.fare ?? trip.estimated_fare ?? 0);
        if (Number.isFinite(fareMajor) && fareMajor > 0) {
          payable = Math.round(fareMajor * 100);
          source = "fare_column";
        }
      }
    }
  }

  payable = Math.max(0, Math.round(payable));

  return {
    payable_pence: payable,
    payable_major: majorFromPence(payable),
    original_pence: original,
    original_major: original != null ? majorFromPence(original) : null,
    discount_pence: discount,
    commission_base_pence: payable,
    source,
  };
}

/** Commission base for settlement — final_fare_pence ONLY (excludes tips). */
export function resolveCommissionBasePence(trip: TripDisplayFareRow): number {
  return resolveTripDisplayFare(trip).commission_base_pence;
}

function resolveDiscountFields(input: BookingFarePersistInput) {
  const gross = Math.max(0, Math.round(input.grossFarePence));
  const payable = Math.max(0, Math.round(input.finalPayableFarePence));
  const voucherDiscount = Math.max(0, Math.round(input.voucherDiscountPence ?? 0));
  const offerDiscount = Math.max(0, Math.round(input.offerDiscountPence ?? 0));
  const source = input.discountSource ??
    (voucherDiscount > 0 ? "personal_voucher" : offerDiscount > 0 ? "global_offer" : null);
  const discount = source === "personal_voucher"
    ? voucherDiscount
    : source === "global_offer"
    ? offerDiscount
    : 0;
  return { gross, payable, voucherDiscount, offerDiscount, source, discount };
}

/** Stable hash of booking financial snapshot for audit / monitor. */
export function computeBookingPricingHash(fields: {
  gross_fare_pence: number;
  offer_discount_pence: number;
  voucher_discount_pence: number;
  final_fare_pence: number;
  discount_source: string | null;
  pricing_version: string;
}): string {
  const payload = JSON.stringify({
    g: fields.gross_fare_pence,
    o: fields.offer_discount_pence,
    v: fields.voucher_discount_pence,
    f: fields.final_fare_pence,
    d: fields.discount_source,
    vsn: fields.pricing_version,
  });
  let hash = 0;
  for (let i = 0; i < payload.length; i++) {
    hash = ((hash << 5) - hash + payload.charCodeAt(i)) | 0;
  }
  return `bk_${Math.abs(hash).toString(16)}`;
}

export function validateBookingFinancialSnapshot(
  snapshot: Pick<
    BookingFinancialSnapshot,
    | "gross_fare_pence"
    | "offer_discount_pence"
    | "voucher_discount_pence"
    | "discount_pence"
    | "final_fare_pence"
    | "final_customer_fare_pence"
    | "estimated_total_pence"
  >,
): void {
  const {
    gross_fare_pence: gross,
    offer_discount_pence: offerDisc,
    voucher_discount_pence: voucherDisc,
    discount_pence: discount,
    final_fare_pence: finalFare,
    final_customer_fare_pence: finalCustomer,
    estimated_total_pence: estimatedTotal,
  } = snapshot;

  if (gross < 0 || finalFare < 0) {
    throw new BookingFinancialSnapshotError("Invalid negative fare", "NEGATIVE_FARE");
  }

  if (discount > 0) {
    if (finalFare <= 0 || finalCustomer <= 0 || estimatedTotal <= 0) {
      throw new BookingFinancialSnapshotError(
        "Discount requires final_fare_pence, final_customer_fare_pence, and estimated_total_pence",
        "DISCOUNT_MISSING_FINAL_FARE",
        { gross, discount, finalFare, finalCustomer, estimatedTotal },
      );
    }
    const expected = Math.max(0, gross - discount);
    if (finalFare !== expected || finalCustomer !== expected || estimatedTotal !== expected) {
      throw new BookingFinancialSnapshotError(
        "gross_fare_pence - discount_pence must equal final_fare_pence",
        "FARE_ARITHMETIC_MISMATCH",
        { gross, discount, expected, finalFare, finalCustomer, estimatedTotal },
      );
    }
  } else if (gross > 0 && finalFare > 0 && finalFare !== gross && offerDisc === 0 && voucherDisc === 0) {
    // Allow small rounding only when no discount declared
    if (Math.abs(finalFare - gross) > 1) {
      throw new BookingFinancialSnapshotError(
        "Undeclared discount: final fare differs from gross",
        "UNDECLARED_DISCOUNT",
        { gross, finalFare },
      );
    }
  }

  if (offerDisc > 0 && voucherDisc > 0) {
    throw new BookingFinancialSnapshotError(
      "Cannot apply both offer and voucher discount on one trip",
      "DUAL_DISCOUNT",
    );
  }
}

export function buildBookingFinancialSnapshot(
  input: BookingFarePersistInput,
  fareSnapshotJson: Record<string, unknown> | null | undefined,
): BookingFinancialSnapshot {
  const { gross, payable, voucherDiscount, offerDiscount, source, discount } =
    resolveDiscountFields(input);
  const pricingSource = input.pricingSource ?? "create-ride";

  const fare_snapshot_json: Record<string, unknown> = {
    ...(fareSnapshotJson ?? {}),
    gross_fare_pence: gross,
    locked_base_fare_pence: gross,
    final_payable_fare_pence: payable,
    canonical_payable_fare_pence: payable,
    final_fare_pence: payable,
    final_customer_fare_pence: payable,
    base_payable_fare_pence: payable,
    offer_discount_pence: source === "global_offer" ? offerDiscount : 0,
    voucher_discount_pence: source === "personal_voucher" ? voucherDiscount : 0,
    promotion_discount_pence: source === "global_offer" ? offerDiscount : 0,
    discount_pence: discount,
    discount_source: source,
    pricing_version: BOOKING_PRICING_VERSION,
    pricing_source: pricingSource,
    financial_ssot_locked_at: new Date().toISOString(),
  };

  const partial: BookingFinancialSnapshot = {
    gross_fare_pence: gross,
    offer_discount_pence: source === "global_offer" ? offerDiscount : 0,
    voucher_discount_pence: source === "personal_voucher" ? voucherDiscount : 0,
    discount_pence: discount,
    discount_source: source,
    final_fare_pence: payable,
    final_customer_fare_pence: payable,
    estimated_total_pence: payable,
    fare_major: payable / 100,
    estimated_fare_major: payable / 100,
    pricing_version: BOOKING_PRICING_VERSION,
    pricing_source: pricingSource,
    created_pricing_hash: "",
    fare_snapshot_json,
  };

  partial.created_pricing_hash = computeBookingPricingHash({
    gross_fare_pence: partial.gross_fare_pence,
    offer_discount_pence: partial.offer_discount_pence,
    voucher_discount_pence: partial.voucher_discount_pence,
    final_fare_pence: partial.final_fare_pence,
    discount_source: partial.discount_source,
    pricing_version: partial.pricing_version,
  });
  fare_snapshot_json.created_pricing_hash = partial.created_pricing_hash;

  validateBookingFinancialSnapshot(partial);

  return partial;
}

/** Apply immutable booking financial snapshot to trip insert payload. Throws on invalid snapshot. */
export function applyBookingFinancialSnapshotToTripData(
  tripData: Record<string, unknown>,
  fareSnapshotJson: Record<string, unknown> | null | undefined,
  input: BookingFarePersistInput,
): BookingFinancialSnapshot {
  const snapshot = buildBookingFinancialSnapshot(input, fareSnapshotJson);

  tripData.gross_fare_pence = snapshot.gross_fare_pence;
  tripData.locked_base_fare_pence = snapshot.gross_fare_pence;
  tripData.offer_discount_pence = snapshot.offer_discount_pence;
  tripData.voucher_discount_pence = snapshot.voucher_discount_pence;
  tripData.discount_pence = snapshot.discount_pence;
  tripData.discount_source = snapshot.discount_source;
  tripData.final_fare_pence = snapshot.final_fare_pence;
  tripData.final_customer_fare_pence = snapshot.final_customer_fare_pence;
  tripData.estimated_total_pence = snapshot.estimated_total_pence;
  tripData.fare = snapshot.fare_major;
  tripData.estimated_fare = snapshot.estimated_fare_major;
  tripData.pricing_version = snapshot.pricing_version;
  tripData.pricing_source = snapshot.pricing_source;
  tripData.created_pricing_hash = snapshot.created_pricing_hash;
  tripData.fare_snapshot_json = snapshot.fare_snapshot_json;

  if (input.appliedOfferId && snapshot.discount_source === "global_offer") {
    tripData.applied_offer_id = input.appliedOfferId;
  } else if (snapshot.discount_source !== "global_offer") {
    tripData.applied_offer_id = null;
    tripData.applied_offer_code = null;
  }
  if (input.appliedPersonalVoucherId) {
    tripData.applied_personal_voucher_id = input.appliedPersonalVoucherId;
    tripData.applied_personal_voucher_code = input.appliedPersonalVoucherCode ?? null;
  }

  return snapshot;
}

/** @deprecated Use applyBookingFinancialSnapshotToTripData */
export function applyBookingFareToTripData(
  tripData: Record<string, unknown>,
  fareSnapshotJson: Record<string, unknown> | null | undefined,
  input: BookingFarePersistInput,
): Record<string, unknown> {
  applyBookingFinancialSnapshotToTripData(tripData, fareSnapshotJson, input);
  return tripData.fare_snapshot_json as Record<string, unknown>;
}
