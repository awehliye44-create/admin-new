import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildDriverOffersPayload,
  type DriverEligibilityContext,
  type DriverSpecialOfferRow,
  type OfferAreaMap,
} from "../_shared/driverSpecialOffersSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/**
 * Driver Special Offers feed (banner + list) for the Driver Expo app.
 * Eligibility is applied on the backend — the app never downloads ineligible offers.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "UNAUTHENTICATED" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "UNAUTHENTICATED" }, 401);

    const { data: driver, error: driverErr } = await admin
      .from("drivers")
      .select("id, service_area_id, total_trips, category_id, created_at")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (driverErr) throw driverErr;
    if (!driver) return json({ error: "DRIVER_PROFILE_REQUIRED" }, 403);

    let tierName: string | null = null;
    if (driver.category_id) {
      const { data: cat } = await admin
        .from("driver_categories")
        .select("name")
        .eq("id", driver.category_id)
        .maybeSingle();
      tierName = cat?.name ?? null;
    }

    const { data: offers, error: offersErr } = await admin
      .from("driver_special_offers")
      .select("*")
      .eq("status", "published")
      .eq("is_active", true);
    if (offersErr) throw offersErr;

    const offerIds = (offers ?? []).map((o: { id: string }) => o.id);
    const areaMap: OfferAreaMap = {};
    if (offerIds.length) {
      const { data: links, error: linkErr } = await admin
        .from("driver_special_offer_service_areas")
        .select("offer_id, service_area_id")
        .in("offer_id", offerIds);
      if (linkErr) throw linkErr;
      for (const l of links ?? []) {
        (areaMap[l.offer_id] ??= []).push(l.service_area_id);
      }
    }

    const context: DriverEligibilityContext = {
      service_area_id: driver.service_area_id ?? null,
      total_trips: driver.total_trips ?? 0,
      tier_name: tierName,
      created_at: driver.created_at ?? null,
    };

    const payload = buildDriverOffersPayload(
      (offers ?? []) as DriverSpecialOfferRow[],
      areaMap,
      context,
    );

    // Strip internal-only fields before returning to the app.
    const sanitised = payload.offers.map((o) => ({
      id: o.id,
      title: o.title,
      partner_name: o.partner_name,
      short_description: o.short_description,
      full_details: o.full_details,
      badge_label: o.badge_label,
      image_path: o.image_path,
      website_url: o.website_url,
      phone_number: o.phone_number,
      email_address: o.email_address,
      promo_code: o.promo_code,
      internal_route: o.internal_route,
      website_button_label: o.website_button_label ?? "Website",
      phone_button_label: o.phone_button_label ?? "Phone",
      email_button_label: o.email_button_label ?? "Email",
      is_featured: o.is_featured,
      display_order: o.display_order,
    }));

    return json({
      banner: payload.banner,
      offers: sanitised,
      empty: sanitised.length === 0,
      empty_copy: payload.empty_copy,
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
