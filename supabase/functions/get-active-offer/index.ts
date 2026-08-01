/**
 * get-active-offer
 * -----------------
 * Resolve the single best eligible customer promo for a service area.
 * Consumed by the Customer app Home banner (no fare) and Choose Ride (with fare).
 *
 * Eligibility (aligned with apply-offer + admin Customer Offers):
 *   - is_enabled = true
 *   - status = 'active'
 *   - starts_at <= now
 *   - ends_at is null OR ends_at > now
 *   - linked to the service area OR global (no offer_service_areas rows)
 *   - usage / first-ride / per-user limits when applicable
 *
 * Toggle OFF or expired window → { offer: null }.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ReqBody {
  service_area_id?: string | null;
  estimated_fare_pence?: number | null;
}

type OfferRow = {
  id: string;
  name: string;
  code: string;
  banner_title: string;
  banner_subtitle: string | null;
  badge_text: string | null;
  cta_text: string;
  offer_type: string;
  discount_value: number;
  currency: string;
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
  terms: string | null;
  style_variant: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function calcDiscountPence(offer: OfferRow, fareP: number): number {
  if (fareP <= 0) return 0;
  let raw = 0;
  if (offer.offer_type === "percent_discount") {
    raw = Math.floor((fareP * Number(offer.discount_value)) / 100);
  } else {
    // fixed_amount_discount: discount_value is major units (£2 → 200p)
    raw = Math.round(Number(offer.discount_value) * 100);
  }
  if (offer.max_discount_pence != null) {
    raw = Math.min(raw, offer.max_discount_pence);
  }
  return Math.max(0, Math.min(raw, fareP));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    let userId: string | null = null;
    const authHeader = req.headers.get("Authorization") ?? "";
    if (authHeader) {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const {
        data: { user },
      } = await userClient.auth.getUser();
      userId = user?.id ?? null;
    }

    let body: ReqBody = {};
    try {
      body = (await req.json()) as ReqBody;
    } catch {
      /* empty body OK */
    }

    const serviceAreaId = body.service_area_id ?? null;
    const fareP = Math.max(0, Math.floor(Number(body.estimated_fare_pence) || 0));

    if (!serviceAreaId) {
      return json({ offer: null, reason: "no_service_area" });
    }

    const nowIso = new Date().toISOString();
    const { data: offers, error: offersErr } = await admin
      .from("offers")
      .select(
        "id,name,code,banner_title,banner_subtitle,badge_text,cta_text,offer_type,discount_value,currency,min_fare_pence,max_discount_pence,starts_at,ends_at,is_enabled,status,first_ride_only,new_customer_only,per_user_limit,total_usage_limit,usage_count,priority,terms,style_variant",
      )
      .eq("is_enabled", true)
      .eq("status", "active")
      .lte("starts_at", nowIso)
      .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
      .order("priority", { ascending: false });

    if (offersErr) throw offersErr;

    const list = (offers ?? []) as OfferRow[];
    if (list.length === 0) {
      return json({ offer: null, reason: "no_active_offers" });
    }

    const ids = list.map((o) => o.id);
    const { data: links, error: linkErr } = await admin
      .from("offer_service_areas")
      .select("offer_id, service_area_id")
      .in("offer_id", ids);
    if (linkErr) throw linkErr;

    const scopeMap = new Map<string, Set<string>>();
    for (const row of links ?? []) {
      const set = scopeMap.get(row.offer_id) ?? new Set<string>();
      set.add(row.service_area_id);
      scopeMap.set(row.offer_id, set);
    }

    // Global (no rows) OR explicitly linked to this service area — same as apply-offer.
    const scoped = list.filter((o) => {
      const scope = scopeMap.get(o.id);
      if (!scope || scope.size === 0) return true;
      return scope.has(serviceAreaId);
    });

    if (scoped.length === 0) {
      return json({ offer: null, reason: "no_linked_offers" });
    }

    let customerId: string | null = null;
    let totalCompletedTrips = 0;
    if (userId) {
      const { data: cust } = await admin
        .from("customers")
        .select("id")
        .eq("user_id", userId)
        .maybeSingle();
      customerId = cust?.id ?? null;
      if (customerId) {
        // trips.passenger_id is the rider FK (customers.id). trips.customer_id
        // does not exist — filtering on it 42703s and under-counts trips.
        const { count } = await admin
          .from("trips")
          .select("id", { count: "exact", head: true })
          .eq("passenger_id", customerId)
          .in("status", ["COMPLETED", "completed"]);
        totalCompletedTrips = count ?? 0;
      }
    }

    const eligible: { offer: OfferRow; discountP: number }[] = [];

    for (const o of scoped) {
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

      if (fareP > 0 && fareP < (o.min_fare_pence ?? 0)) continue;

      const discountP = fareP > 0 ? calcDiscountPence(o, fareP) : 0;
      eligible.push({ offer: o, discountP });
    }

    if (eligible.length === 0) {
      return json({ offer: null, reason: "not_eligible" });
    }

    eligible.sort((a, b) => {
      if (fareP > 0 && b.discountP !== a.discountP) return b.discountP - a.discountP;
      return b.offer.priority - a.offer.priority;
    });
    const best = eligible[0];

    return json({
      offer: {
        id: best.offer.id,
        name: best.offer.name,
        code: best.offer.code,
        banner_title: best.offer.banner_title,
        banner_subtitle: best.offer.banner_subtitle,
        badge_text: best.offer.badge_text,
        cta_text: best.offer.cta_text,
        offer_type: best.offer.offer_type,
        discount_value: Number(best.offer.discount_value),
        currency: best.offer.currency,
        min_fare_pence: best.offer.min_fare_pence,
        max_discount_pence: best.offer.max_discount_pence,
        terms: best.offer.terms,
        style_variant: best.offer.style_variant,
        starts_at: best.offer.starts_at,
        ends_at: best.offer.ends_at,
        is_enabled: best.offer.is_enabled,
      },
      discount_pence: best.discountP,
      estimated_fare_pence: fareP,
      final_fare_pence: Math.max(0, fareP - best.discountP),
    });
  } catch (err) {
    console.error("[get-active-offer] error", err);
    const msg = err instanceof Error ? err.message : "unknown";
    return json({ offer: null, error: msg }, 500);
  }
});
