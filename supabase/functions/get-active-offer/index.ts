// Resolve the single best eligible offer for the current customer + service area.
// Strict scope: an offer is only eligible if it is explicitly linked to the
// service area in `offer_service_areas`.
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
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
  offer_type: string; // 'percent_discount' | 'flat_discount'
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

function calcDiscountPence(offer: OfferRow, fareP: number): number {
  if (fareP <= 0) return 0;
  let raw = 0;
  if (offer.offer_type === "percent_discount") {
    raw = Math.floor((fareP * Number(offer.discount_value)) / 100);
  } else {
    // flat_discount stored in major units (e.g. £2.00) → pence
    raw = Math.round(Number(offer.discount_value) * 100);
  }
  if (offer.max_discount_pence != null) {
    raw = Math.min(raw, offer.max_discount_pence);
  }
  return Math.max(0, Math.min(raw, fareP));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    // Identify user (optional — anonymous home views still get banner if eligible)
    let userId: string | null = null;
    const authHeader = req.headers.get("Authorization") ?? "";
    if (authHeader) {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await userClient.auth.getUser();
      userId = user?.id ?? null;
    }

    let body: ReqBody = {};
    try { body = (await req.json()) as ReqBody; } catch { /* empty body OK */ }

    const serviceAreaId = body.service_area_id ?? null;
    const fareP = Math.max(0, Math.floor(Number(body.estimated_fare_pence) || 0));

    if (!serviceAreaId) {
      return new Response(JSON.stringify({ offer: null, reason: "no_service_area" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Strict scope — only offers explicitly linked to this service area
    const { data: links, error: linkErr } = await admin
      .from("offer_service_areas")
      .select("offer_id")
      .eq("service_area_id", serviceAreaId);

    if (linkErr) throw linkErr;
    const offerIds = (links ?? []).map((r: { offer_id: string }) => r.offer_id);
    if (offerIds.length === 0) {
      return new Response(JSON.stringify({ offer: null, reason: "no_linked_offers" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const nowIso = new Date().toISOString();
    const { data: offers, error: offersErr } = await admin
      .from("offers")
      .select(
        "id,name,code,banner_title,banner_subtitle,badge_text,cta_text,offer_type,discount_value,currency,min_fare_pence,max_discount_pence,starts_at,ends_at,is_enabled,status,first_ride_only,new_customer_only,per_user_limit,total_usage_limit,usage_count,priority,terms,style_variant",
      )
      .in("id", offerIds)
      .eq("is_enabled", true)
      .eq("status", "active")
      .lte("starts_at", nowIso)
      .order("priority", { ascending: false });

    if (offersErr) throw offersErr;

    // Resolve customer.id once if logged in (for redemption / first-ride checks)
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
        const { count } = await admin
          .from("trips")
          .select("id", { count: "exact", head: true })
          .eq("passenger_id", customerId)
          .eq("status", "completed");
        totalCompletedTrips = count ?? 0;
      }
    }

    const eligible: { offer: OfferRow; discountP: number }[] = [];

    for (const o of (offers ?? []) as OfferRow[]) {
      // Time window
      if (o.ends_at && new Date(o.ends_at).getTime() <= Date.now()) continue;
      // Total usage
      if (o.total_usage_limit != null && o.usage_count >= o.total_usage_limit) continue;
      // First ride / new customer
      if ((o.first_ride_only || o.new_customer_only) && totalCompletedTrips > 0) continue;
      // Per-user limit
      if (userId && o.per_user_limit != null) {
        const { count } = await admin
          .from("offer_redemptions")
          .select("id", { count: "exact", head: true })
          .eq("offer_id", o.id)
          .eq("user_id", userId)
          .eq("status", "applied");
        if ((count ?? 0) >= o.per_user_limit) continue;
      }
      // Min fare (only when fare known)
      if (fareP > 0 && fareP < o.min_fare_pence) continue;

      const discountP = fareP > 0 ? calcDiscountPence(o, fareP) : 0;
      eligible.push({ offer: o, discountP });
    }

    if (eligible.length === 0) {
      return new Response(JSON.stringify({ offer: null, reason: "not_eligible" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Best = highest discount when fare known, else highest priority (already sorted)
    eligible.sort((a, b) => {
      if (fareP > 0 && b.discountP !== a.discountP) return b.discountP - a.discountP;
      return b.offer.priority - a.offer.priority;
    });
    const best = eligible[0];

    return new Response(
      JSON.stringify({
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
        },
        discount_pence: best.discountP,
        estimated_fare_pence: fareP,
        final_fare_pence: Math.max(0, fareP - best.discountP),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[get-active-offer] error", err);
    const msg = err instanceof Error ? err.message : "unknown";
    return new Response(JSON.stringify({ offer: null, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
