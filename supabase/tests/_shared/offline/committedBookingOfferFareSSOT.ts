/** Offline test/audit-only helpers; not part of Edge uploads. */
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
  prePromotionCustomerPence,
  resolveGlobalOfferPromotionPence,
  resolvePersistedAirportChargePence,
  resolveQuoteAirportChargePence,
  resolveQuoteFinalFarePence,
  resolveQuoteRideFarePence,
} from "../../../functions/_shared/airportChargeFareSplitSSOT.ts";

import { resolveDiscountPenceFromTrip, type TripDisplayFareRow } from "../../../functions/_shared/tripDisplayFareSSOT.ts";
import { CommittedOfferFareTrip, CommittedOfferFareOptions, resolveCommittedOfferGross } from "../../../functions/_shared/committedBookingOfferFareSSOT.ts";


/** Committed offer gross in pence (0 when unresolved). */
export function resolveCommittedOfferGrossPence(
  trip: CommittedOfferFareTrip | null | undefined,
  options: CommittedOfferFareOptions = {},
): number {
  return resolveCommittedOfferGross(trip, options).pence;
}

export * from "../../../functions/_shared/committedBookingOfferFareSSOT.ts";
