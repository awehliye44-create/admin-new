/**
 * Normalize trip fare_breakdown / fare_snapshot_json for ride_offers.offer_snapshot.
 * Keeps driver offer UI aligned with customer pricing-engine output.
 *
 * `airport_charge_pence` is pence. `airportCharge` / `airport_charge` are major
 * units from the pricing engine (pounds), never "already pence if >= 100".
 */
import {
  buildAirportRouteExtraItems,
  resolveQuoteAirportChargePence,
  resolveQuoteRideFarePence,
} from "./airportChargeFareSplitSSOT.ts";

export function tripFareFieldsForOfferSnapshot(
  trip: Record<string, unknown>,
): Record<string, unknown> {
  const raw = trip.fare_breakdown ?? trip.fare_snapshot_json;
  if (!raw || typeof raw !== "object") return {};
  const breakdown = raw as Record<string, unknown>;

  const out: Record<string, unknown> = {};

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

  return out;
}
