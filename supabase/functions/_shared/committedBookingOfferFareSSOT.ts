/**
 * Committed booking offer fare SSOT (MK-261113-004/005).
 *
 * A Driver offer's gross (commission base) is the customer's COMMITTED booking
 * payable — the amount locked at booking / pre-authorised — never a stale
 * `fare_breakdown` that a later pricing-engine pass re-wrote (e.g. a £5.00
 * minimum-fare floor beside a committed £4.80 payable).
 *
 * Priority (first positive wins):
 *   1. locked_base_fare_pence            (only when no discount / folded modification;
 *                                         otherwise it is a GROSS basis and is skipped)
 *   2. final_customer_fare_pence
 *   3. final_fare_pence
 *   4. estimated_total_pence
 *   5. fare_snapshot_json committed / canonical / final_payable / original (net of discount)
 *   6. authorised_amount_pence on the trip or its payment session
 *   7. ONLY THEN fare_breakdown (final → ride + airport) and fare / estimated_fare columns
 *
 * fare_breakdown.trip_fare_pence / totalFare is NEVER preferred over a committed
 * column/snapshot, even when they disagree. Waiting charges, tips and later
 * adjustments are not part of an offer gross.
 *
 * Does not touch pricing-engine minimum policy, Revolut, capture or settlement.
 */

import {
  driverNetFromCustomerTotal,
  resolvePersistedAirportChargePence,
  resolveQuoteAirportChargePence,
  resolveQuoteFinalFarePence,
  resolveQuoteRideFarePence,
} from "./airportChargeFareSplitSSOT.ts";
import { resolveDiscountPenceFromTrip, type TripDisplayFareRow } from "./tripDisplayFareSSOT.ts";

export type CommittedOfferFareSource =
  | "locked_base_fare_pence"
  | "final_customer_fare_pence"
  | "final_fare_pence"
  | "estimated_total_pence"
  | "fare_snapshot_committed"
  | "authorised_amount_pence"
  | "fare_breakdown"
  | "fare_column"
  | "none";

export type CommittedOfferFareTrip = {
  locked_base_fare_pence?: number | null;
  final_customer_fare_pence?: number | null;
  final_fare_pence?: number | null;
  estimated_total_pence?: number | null;
  gross_fare_pence?: number | null;
  authorised_amount_pence?: number | null;
  estimated_fare?: number | null;
  fare?: number | null;
  customer_modification_charge_pence?: number | null;
  airport_charge_pence?: number | null;
  other_pass_through_charges_pence?: number | null;
  offer_discount_pence?: number | null;
  voucher_discount_pence?: number | null;
  promotion_discount_pence?: number | null;
  discount_pence?: number | null;
  discount_source?: string | null;
  fare_snapshot_json?: unknown;
  fare_breakdown?: unknown;
};

export type CommittedOfferFareOptions = {
  /** payment_sessions row (or snapshot) — authorised_amount_pence fallback. */
  paymentSession?: { authorised_amount_pence?: number | null } | null;
};

export type ResolvedCommittedOfferGross = {
  pence: number;
  source: CommittedOfferFareSource;
  /**
   * True when the amount came from a committed column / snapshot / authorisation.
   * False when it only came from fare_breakdown / fare columns (legacy trips).
   */
  committed: boolean;
};

function nonNeg(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

const SNAPSHOT_COMMITTED_KEYS = [
  "committed_fare_pence",
  "canonical_payable_fare_pence",
  "final_payable_fare_pence",
  "final_customer_fare_pence",
  "base_payable_fare_pence",
  "fare_after_discount_pence",
] as const;

function resolveSnapshotCommittedPence(
  snap: Record<string, unknown> | null,
  discountPence: number,
): number {
  if (!snap) return 0;
  for (const key of SNAPSHOT_COMMITTED_KEYS) {
    const n = nonNeg(snap[key]);
    if (n > 0) return n;
  }
  // original_fare_pence is the PRE-discount gross — net it before using as payable.
  const original = nonNeg(snap.original_fare_pence);
  if (original > 0) {
    const net = discountPence > 0 ? Math.max(0, original - discountPence) : original;
    if (net > 0) return net;
  }
  return 0;
}

function committed(pence: number, source: CommittedOfferFareSource): ResolvedCommittedOfferGross {
  return { pence, source, committed: true };
}

/** Resolve the committed offer gross plus the source it came from. */
export function resolveCommittedOfferGross(
  trip: CommittedOfferFareTrip | null | undefined,
  options: CommittedOfferFareOptions = {},
): ResolvedCommittedOfferGross {
  if (!trip) return { pence: 0, source: "none", committed: false };

  const discount = resolveDiscountPenceFromTrip(trip as TripDisplayFareRow);
  const modStored = Math.round(Number(trip.customer_modification_charge_pence) || 0);

  // 1. locked_base — a gross basis: skip when a discount / modification makes it ≠ payable.
  const lockedBase = nonNeg(trip.locked_base_fare_pence);
  if (lockedBase > 0 && discount === 0 && modStored === 0) {
    return committed(lockedBase, "locked_base_fare_pence");
  }

  // 2. final_customer_fare_pence
  const finalCustomer = nonNeg(trip.final_customer_fare_pence);
  if (finalCustomer > 0) return committed(finalCustomer, "final_customer_fare_pence");

  // 3. final_fare_pence (gross-equals-final with a discount means it is still pre-discount)
  const finalFare = nonNeg(trip.final_fare_pence);
  if (finalFare > 0) {
    const gross = nonNeg(trip.gross_fare_pence);
    const net = discount > 0 && gross > 0 && finalFare === gross
      ? Math.max(0, finalFare - discount)
      : finalFare;
    if (net > 0) return committed(net, "final_fare_pence");
  }

  // 4. estimated_total_pence
  const estimatedTotal = nonNeg(trip.estimated_total_pence);
  if (estimatedTotal > 0) return committed(estimatedTotal, "estimated_total_pence");

  // 5. fare_snapshot_json committed / canonical / final_payable / original
  const snapshot = asRecord(trip.fare_snapshot_json);
  const fromSnapshot = resolveSnapshotCommittedPence(snapshot, discount);
  if (fromSnapshot > 0) return committed(fromSnapshot, "fare_snapshot_committed");

  // gross − discount from the trip columns (booking snapshot column family)
  const grossColumn = nonNeg(trip.gross_fare_pence);
  if (grossColumn > 0 && discount > 0) {
    const net = Math.max(0, grossColumn - discount);
    if (net > 0) return committed(net, "fare_snapshot_committed");
  }

  // 6. authorised amount on trip / payment session
  const authorised = nonNeg(trip.authorised_amount_pence)
    || nonNeg(options.paymentSession?.authorised_amount_pence);
  if (authorised > 0) return committed(authorised, "authorised_amount_pence");

  // 7. fare_breakdown — only when nothing committed exists.
  const breakdown = asRecord(trip.fare_breakdown) ?? snapshot;
  if (breakdown) {
    const final = resolveQuoteFinalFarePence(breakdown);
    if (final > 0) return { pence: final, source: "fare_breakdown", committed: false };
    const ride = resolveQuoteRideFarePence(breakdown);
    if (ride > 0) {
      return {
        pence: ride + resolveQuoteAirportChargePence(breakdown),
        source: "fare_breakdown",
        committed: false,
      };
    }
  }
  if (grossColumn > 0) {
    return { pence: grossColumn, source: "fare_column", committed: false };
  }
  const fareMajor = Number(trip.fare ?? 0) > 0 ? Number(trip.fare) : Number(trip.estimated_fare ?? 0);
  if (Number.isFinite(fareMajor) && fareMajor > 0) {
    return { pence: Math.round(fareMajor * 100), source: "fare_column", committed: false };
  }
  return { pence: 0, source: "none", committed: false };
}

/** Committed offer gross in pence (0 when unresolved). */
export function resolveCommittedOfferGrossPence(
  trip: CommittedOfferFareTrip | null | undefined,
  options: CommittedOfferFareOptions = {},
): number {
  return resolveCommittedOfferGross(trip, options).pence;
}

/**
 * Overlay the committed payable onto offer-snapshot fare fields so a snapshot can
 * never advertise a stale breakdown figure (500) beside the committed payable (480).
 * `trip_fare*` is the ride portion (payable − airport); `final*` / `total*` is the payable.
 */
export function overlayCommittedPayableOnFareFields(
  fields: Record<string, unknown>,
  payablePence: number,
  airportPence: number,
): Record<string, unknown> {
  const payable = nonNeg(payablePence);
  if (payable <= 0) return fields;
  const airport = Math.min(nonNeg(airportPence), payable);
  const ride = payable - airport;
  const out: Record<string, unknown> = { ...fields };
  out.tripFare = ride / 100;
  out.trip_fare = ride / 100;
  out.trip_fare_pence = ride;
  out.finalFare = payable / 100;
  out.final_fare = payable / 100;
  out.totalFare = payable / 100;
  out.total_fare = payable / 100;
  out.final_fare_pence = payable;
  out.total_fare_pence = payable;
  out.committed_fare_pence = payable;
  return out;
}

export type CommittedOfferDriverNetStamp = {
  ok: boolean;
  grossPence: number;
  source: CommittedOfferFareSource;
  committed: boolean;
  airportPence: number;
  otherPassThroughPence: number;
  commissionablePence: number;
  commissionPence: number;
  driverNetPence: number;
  commissionPercent: number;
};

/**
 * Driver net for an offer, from the committed gross and the caller's effective
 * (wave) commission. No hardcoded rate. Airport is non-commissionable pass-through
 * (clamped so it can never exceed the gross it sits inside).
 */
export function stampOfferDriverNetFromCommittedFare(input: {
  trip: CommittedOfferFareTrip | null | undefined;
  commissionPercent: number;
  airportPence?: number | null;
  otherPassThrough?: number | null;
  paymentSession?: CommittedOfferFareOptions["paymentSession"];
}): CommittedOfferDriverNetStamp {
  const resolved = resolveCommittedOfferGross(input.trip, { paymentSession: input.paymentSession });
  const gross = resolved.pence;
  const pct = Number(input.commissionPercent);
  const rateOk = Number.isFinite(pct) && pct >= 0;

  const airportRaw = input.airportPence != null
    ? nonNeg(input.airportPence)
    : input.trip
    ? resolvePersistedAirportChargePence({
      airport_charge_pence: input.trip.airport_charge_pence,
      fare_breakdown: input.trip.fare_breakdown,
      fare_snapshot_json: input.trip.fare_snapshot_json,
    })
    : 0;
  const airportPence = Math.min(airportRaw, gross);
  const otherRaw = input.otherPassThrough != null
    ? nonNeg(input.otherPassThrough)
    : nonNeg(input.trip?.other_pass_through_charges_pence);
  const otherPassThroughPence = Math.min(otherRaw, Math.max(0, gross - airportPence));

  if (gross <= 0 || !rateOk) {
    return {
      ok: false,
      grossPence: gross,
      source: resolved.source,
      committed: resolved.committed,
      airportPence,
      otherPassThroughPence,
      commissionablePence: 0,
      commissionPence: 0,
      driverNetPence: 0,
      commissionPercent: rateOk ? pct : 0,
    };
  }

  const split = driverNetFromCustomerTotal({
    customerPence: gross,
    airportPence,
    otherPassThroughPence,
    commissionPercent: pct,
  });
  return {
    ok: split.driverNetPence > 0,
    grossPence: gross,
    source: resolved.source,
    committed: resolved.committed,
    airportPence,
    otherPassThroughPence,
    commissionablePence: split.commissionablePence,
    commissionPence: split.commissionPence,
    driverNetPence: split.driverNetPence,
    commissionPercent: pct,
  };
}

export type CommittedFareDriftOffer = {
  id: string;
  status: string;
  is_stacked?: boolean | null;
  expires_at: string | null;
  dispatch_wave: number | null;
  effective_commission_percent: number | null;
  offer_snapshot: Record<string, unknown> | null;
  offered_driver_net_pence: number | null;
};

export type CommittedFareDriftUpdate = {
  id: string;
  offer_snapshot: Record<string, unknown>;
  offered_driver_net_pence: number;
  match_dispatch_wave: number | null;
};

/**
 * Pending offers created before the committed payable was visible (SQL insert
 * trigger / early broadcast) may carry a net derived from a stale breakdown.
 * Re-stamp ONLY calculated net fields. Never creates, notifies, extends expiry,
 * touches preset gross values, or changes status/wave. Uses each offer's stored
 * commission percent; offers without one are skipped (no invented rate).
 */
export function planCommittedFareDriftRestamp(input: {
  nowMs: number;
  trip: CommittedOfferFareTrip;
  offers: CommittedFareDriftOffer[];
  paymentSession?: CommittedOfferFareOptions["paymentSession"];
}): { updates: CommittedFareDriftUpdate[]; skipped: Array<{ id: string; reason: string }> } {
  const updates: CommittedFareDriftUpdate[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const resolved = resolveCommittedOfferGross(input.trip, { paymentSession: input.paymentSession });
  if (!resolved.committed || resolved.pence <= 0) {
    return {
      updates,
      skipped: input.offers.map((o) => ({ id: o.id, reason: "no_committed_fare" })),
    };
  }

  for (const offer of input.offers) {
    if (offer.status !== "pending") {
      skipped.push({ id: offer.id, reason: "not_pending" });
      continue;
    }
    if (offer.is_stacked === true) {
      skipped.push({ id: offer.id, reason: "stacked" });
      continue;
    }
    const expiresMs = offer.expires_at ? Date.parse(offer.expires_at) : Number.NaN;
    if (!Number.isFinite(expiresMs) || expiresMs <= input.nowMs) {
      skipped.push({ id: offer.id, reason: "expired" });
      continue;
    }
    const rate = offer.effective_commission_percent;
    if (rate == null || !Number.isFinite(Number(rate))) {
      skipped.push({ id: offer.id, reason: "rate_unresolved" });
      continue;
    }
    const stamp = stampOfferDriverNetFromCommittedFare({
      trip: input.trip,
      commissionPercent: Number(rate),
      paymentSession: input.paymentSession,
    });
    if (!stamp.ok) {
      skipped.push({ id: offer.id, reason: "no_net" });
      continue;
    }
    const snapshot = offer.offer_snapshot ? { ...offer.offer_snapshot } : {};
    const snapGross = nonNeg(snapshot.baseFarePence ?? snapshot.final_trip_fare_pence);
    const aligned = offer.offered_driver_net_pence === stamp.driverNetPence
      && snapGross === stamp.grossPence;
    if (aligned) {
      skipped.push({ id: offer.id, reason: "already_committed" });
      continue;
    }
    // Zero-commission display case: the insert trigger keeps a display net.
    // Never overwrite it with the complete fare.
    if (stamp.driverNetPence === stamp.grossPence && stamp.airportPence === 0) {
      skipped.push({ id: offer.id, reason: "display_net_case" });
      continue;
    }
    const next = overlayCommittedPayableOnFareFields(snapshot, stamp.grossPence, stamp.airportPence);
    next.baseFarePence = stamp.grossPence;
    next.final_trip_fare_pence = stamp.grossPence;
    next.committed_fare_source = stamp.source;
    next.driver_net_fare_pence = stamp.driverNetPence;
    next.driver_net_preview_pence = stamp.driverNetPence;
    next.driver_earnings_pence = stamp.driverNetPence;
    next.platform_commission_pence = stamp.commissionPence;
    updates.push({
      id: offer.id,
      offer_snapshot: next,
      offered_driver_net_pence: stamp.driverNetPence,
      match_dispatch_wave: offer.dispatch_wave,
    });
  }
  return { updates, skipped };
}
