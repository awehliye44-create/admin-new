/**
 * Normalize trip fare_breakdown / fare_snapshot_json for ride_offers.offer_snapshot.
 * Keeps driver offer UI aligned with customer pricing-engine output.
 */

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function majorToPence(value: unknown): number | null {
  const n = finiteNumber(value);
  if (n === null || n <= 0) return null;
  return n < 100 ? Math.round(n * 100) : Math.round(n);
}

export function tripFareFieldsForOfferSnapshot(
  trip: Record<string, unknown>,
): Record<string, unknown> {
  const raw = trip.fare_breakdown ?? trip.fare_snapshot_json;
  if (!raw || typeof raw !== "object") return {};
  const breakdown = raw as Record<string, unknown>;

  const out: Record<string, unknown> = {};

  const tripFare = breakdown.tripFare ?? breakdown.trip_fare;
  const tripFarePence = majorToPence(tripFare);
  if (tripFarePence != null) {
    out.tripFare = tripFarePence / 100;
    out.trip_fare = tripFarePence / 100;
    out.trip_fare_pence = tripFarePence;
  }

  const airportCharge = breakdown.airportCharge ?? breakdown.airport_charge;
  const airportPence = majorToPence(airportCharge);
  if (airportPence != null) {
    out.airportCharge = airportPence / 100;
    out.airport_charge = airportPence / 100;
    out.airport_charge_pence = airportPence;
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
