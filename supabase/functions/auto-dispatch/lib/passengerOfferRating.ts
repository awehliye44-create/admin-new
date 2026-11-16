/**
 * Customer rating for the Driver new-ride offer card — aggregate only (no identity).
 * SSOT: public.get_customer_trip_stats (passenger_ratings, skipped excluded).
 *
 * - rating_count > 0  → { passenger_rating: avg, passenger_rating_count: n }
 * - rating_count = 0  → { passenger_rating: null, passenger_rating_count: 0 } ("New customer")
 * - unknown / failure → both null (card hides the rating; never a guessed value)
 */

export type PassengerOfferRating = {
  passenger_rating: number | null;
  passenger_rating_count: number | null;
};

export const UNKNOWN_PASSENGER_OFFER_RATING: PassengerOfferRating = {
  passenger_rating: null,
  passenger_rating_count: null,
};

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function mapPassengerOfferRating(row: unknown): PassengerOfferRating {
  if (!row || typeof row !== "object") return UNKNOWN_PASSENGER_OFFER_RATING;
  const r = row as Record<string, unknown>;
  const count = finiteNumber(r.rating_count);
  if (count == null) return UNKNOWN_PASSENGER_OFFER_RATING;
  const ratingCount = Math.max(0, Math.round(count));
  if (ratingCount === 0) return { passenger_rating: null, passenger_rating_count: 0 };
  const avg = finiteNumber(r.avg_rating);
  // Stars are 1–5; anything else is not a rating.
  if (avg == null || avg < 1 || avg > 5) return UNKNOWN_PASSENGER_OFFER_RATING;
  return {
    passenger_rating: Math.round(avg * 100) / 100,
    passenger_rating_count: ratingCount,
  };
}

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export async function resolvePassengerOfferRating(
  supabase: RpcClient,
  passengerId: string | null | undefined,
): Promise<PassengerOfferRating> {
  if (!passengerId) return UNKNOWN_PASSENGER_OFFER_RATING;
  try {
    const { data, error } = await supabase.rpc("get_customer_trip_stats", {
      _passenger_id: passengerId,
    });
    if (error) {
      console.warn("[passenger-offer-rating] stats_failed", error.message);
      return UNKNOWN_PASSENGER_OFFER_RATING;
    }
    return mapPassengerOfferRating(Array.isArray(data) ? data[0] : data);
  } catch (e) {
    console.warn("[passenger-offer-rating] stats_threw", e instanceof Error ? e.message : String(e));
    return UNKNOWN_PASSENGER_OFFER_RATING;
  }
}
