/**
 * Normalize trip fare_breakdown / fare_snapshot_json for ride_offers.offer_snapshot.
 * Keeps driver offer UI aligned with customer pricing-engine output.
 *
 * `airport_charge_pence` is pence. `airportCharge` / `airport_charge` are major
 * units from the pricing engine (pounds), never "already pence if >= 100".
 *
 * Committed booking payable wins: when a committed column / snapshot exists the
 * ride / final / total fields are overlaid to it (MK-261113-004/005) so the
 * offer snapshot cannot advertise a stale 500 beside a committed 480.
 */
import {
  buildAirportRouteExtraItems,
  resolvePersistedAirportChargePence,
  resolveQuoteAirportChargePence,
  resolveQuoteRideFarePence,
} from "./airportChargeFareSplitSSOT.ts";
import {
  overlayCommittedPayableOnFareFields,
  resolveCommittedOfferGross,
  type CommittedOfferFareTrip,
} from "./committedBookingOfferFareSSOT.ts";

export function tripFareFieldsForOfferSnapshot(
  trip: Record<string, unknown>,
): Record<string, unknown> {
  const raw = trip.fare_breakdown ?? trip.fare_snapshot_json;
  const breakdown = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;

  let out: Record<string, unknown> = {};

  if (breakdown) {
    const tripFarePence = resolveQuoteRideFarePence(breakdown);
    if (tripFarePence > 0) {
      out.tripFare = tripFarePence / 100;
      out.trip_fare = tripFarePence / 100;
      out.trip_fare_pence = tripFarePence;
    }

    const airportPence = resolveQuoteAirportChargePence(breakdown);
    if (airportPence > 0) {
      out.airportCharge = airportPence / 100;
      out.airport_charge = airportPence / 100;
      out.airport_charge_pence = airportPence;
      const extras = buildAirportRouteExtraItems(airportPence);
      if (extras.length > 0) out.route_extra_items = extras;
    }

    const pricingMode = breakdown.pricing_mode ?? breakdown.tripPricingMode;
    if (pricingMode) {
      out.pricing_mode = pricingMode;
      out.tripPricingMode = pricingMode;
    }

    const fareSource = breakdown.fareSource ?? breakdown.fare_source;
    if (fareSource) out.fareSource = fareSource;

    const fareDetails = breakdown.fareDetails ?? breakdown.fare_details;
    if (Array.isArray(fareDetails)) out.fareDetails = fareDetails;
  }

  const committed = resolveCommittedOfferGross(trip as CommittedOfferFareTrip);
  if (committed.committed && committed.pence > 0) {
    const airportPence = resolvePersistedAirportChargePence({
      airport_charge_pence: trip.airport_charge_pence as number | null | undefined,
      fare_breakdown: trip.fare_breakdown,
      fare_snapshot_json: trip.fare_snapshot_json,
    });
    out = overlayCommittedPayableOnFareFields(out, committed.pence, airportPence);
    out.committed_fare_source = committed.source;
  }

  return out;
}
