// Server-side SSOT for resolving the single best eligible offer for a customer
// + service area + estimated fare. Mirrors get-active-offer/index.ts logic so
// that trip-creation endpoints can apply the same discount the customer was
// previewed in SelectVehicle. Never trust client-supplied discount values.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

type OfferRow = {
  id: string;
  code: string;
  currency: string;
  offer_type: string; // 'percent_discount' | 'flat_discount'
  discount_value: number;
  min_fare_pence: number;
  max_discount_pence: number | null;
  starts_at: string;
  ends_at: string | null;
  is_enabled: boolean;
  status: string;
  first_ride_only: boolean;
  new_customer_only: boolean;
  per_user_limit: number | null;
  total_usage_limit: number | null;
  usage_count: number;
  priority: number;
};

export interface ResolvedOffer {
  offerId: string;
  offerCode: string;
  currency: string;
  discountPence: number;
  finalFarePence: number;
}

function calcDiscountPence(o: OfferRow, fareP: number): number {
  if (fareP <= 0) return 0;
  let raw = 0;
  if (o.offer_type === "percent_discount") {
    raw = Math.floor((fareP * Number(o.discount_value)) / 100);
  } else {
    raw = Math.round(Number(o.discount_value) * 100);
  }
  if (o.max_discount_pence != null) raw = Math.min(raw, o.max_discount_pence);
  return Math.max(0, Math.min(raw, fareP));
}

/**
 * Resolve the best eligible offer for the given customer, service area and fare.
 * Returns null when no offer applies. Uses the service-role client so RLS does
 * not block lookups during trip creation.
 */
export async function resolveBestOfferForTrip(opts: {
  admin: SupabaseClient;
  serviceAreaId: string | null | undefined;
  estimatedFarePence: number;
  userId: string | null;
  customerId: string | null;
}): Promise<ResolvedOffer | null> {
  const { admin, serviceAreaId, userId, customerId } = opts;
  const fareP = Math.max(0, Math.floor(Number(opts.estimatedFarePence) || 0));
  if (!serviceAreaId || fareP <= 0) return null;

  const { data: links, error: linkErr } = await admin
    .from("offer_service_areas")
    .select("offer_id")
    .eq("service_area_id", serviceAreaId);
  if (linkErr || !links || links.length === 0) return null;

  const offerIds = links.map((r: { offer_id: string }) => r.offer_id);
  const nowIso = new Date().toISOString();

  const { data: offers, error: offersErr } = await admin
    .from("offers")
    .select(
      "id,code,currency,offer_type,discount_value,min_fare_pence,max_discount_pence,starts_at,ends_at,is_enabled,status,first_ride_only,new_customer_only,per_user_limit,total_usage_limit,usage_count,priority",
    )
    .in("id", offerIds)
    .eq("is_enabled", true)
    .eq("status", "active")
    .lte("starts_at", nowIso)
    .order("priority", { ascending: false });
  if (offersErr || !offers || offers.length === 0) return null;

  let totalCompletedTrips = 0;
  if (customerId) {
    const { count } = await admin
      .from("trips")
      .select("id", { count: "exact", head: true })
      .eq("passenger_id", customerId)
      .eq("status", "completed");
    totalCompletedTrips = count ?? 0;
  }

  const eligible: { offer: OfferRow; discountP: number }[] = [];
  for (const o of offers as OfferRow[]) {
    if (o.ends_at && new Date(o.ends_at).getTime() <= Date.now()) continue;
    if (o.total_usage_limit != null && o.usage_count >= o.total_usage_limit) continue;
    if ((o.first_ride_only || o.new_customer_only) && totalCompletedTrips > 0) continue;
    if (userId && o.per_user_limit != null) {
      const { count } = await admin
        .from("offer_redemptions")
        .select("id", { count: "exact", head: true })
        .eq("offer_id", o.id)
        .eq("user_id", userId)
        .eq("status", "applied");
      if ((count ?? 0) >= o.per_user_limit) continue;
    }
    if (fareP < o.min_fare_pence) continue;
    eligible.push({ offer: o, discountP: calcDiscountPence(o, fareP) });
  }

  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    if (b.discountP !== a.discountP) return b.discountP - a.discountP;
    return b.offer.priority - a.offer.priority;
  });
  const best = eligible[0];
  if (best.discountP <= 0) return null;

  return {
    offerId: best.offer.id,
    offerCode: best.offer.code,
    currency: best.offer.currency,
    discountPence: best.discountP,
    finalFarePence: Math.max(0, fareP - best.discountP),
  };
}
