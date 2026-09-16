import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildCustomerOffersPayload,
  customerEligibilityContext,
  sanitiseOfferForApp,
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

function readServiceAreaId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { service_area_id?: unknown }).service_area_id;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * Customer Special Offers feed (banner + list) for the Customer Expo app.
 *
 * Audience is enforced here: customer offers never mix with driver offers.
 * Geographic match uses a backend-resolved active service area id from
 * `resolve-service-area` (the app does not filter by city name).
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

    const { data: customer, error: customerErr } = await admin
      .from("customers")
      .select("id")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (customerErr) throw customerErr;
    if (!customer) return json({ error: "CUSTOMER_PROFILE_REQUIRED" }, 403);

    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const requestedAreaId = readServiceAreaId(body);

    let areaActive = false;
    let regionId: string | null = null;
    let resolvedAreaId: string | null = null;
    if (requestedAreaId) {
      const { data: area, error: areaErr } = await admin
        .from("service_areas")
        .select("id, is_active, region_id")
        .eq("id", requestedAreaId)
        .maybeSingle();
      if (areaErr) throw areaErr;
      if (area?.is_active === true) {
        areaActive = true;
        resolvedAreaId = area.id;
        regionId = area.region_id ?? null;
      }
    }

    const { data: offers, error: offersErr } = await admin
      .from("driver_special_offers")
      .select("*")
      .eq("audience", "customer")
      .eq("status", "published")
      .eq("is_active", true);
    if (offersErr) throw offersErr;

    const offerIds = (offers ?? []).map((o: { id: string }) => o.id);
    const areaMap: OfferAreaMap = {};
    // Join table has no FK to service_areas, so PostgREST cannot embed
    // `service_areas!inner(...)`. The requested area is already confirmed active above.
    if (offerIds.length && resolvedAreaId && areaActive) {
      const { data: links, error: linkErr } = await admin
        .from("driver_special_offer_service_areas")
        .select("offer_id, service_area_id")
        .in("offer_id", offerIds)
        .eq("service_area_id", resolvedAreaId);
      if (linkErr) throw linkErr;
      for (const l of (links ?? []) as Array<{ offer_id: string; service_area_id: string }>) {
        (areaMap[l.offer_id] ??= []).push(l.service_area_id);
      }
    }

    const payload = buildCustomerOffersPayload(
      (offers ?? []) as DriverSpecialOfferRow[],
      areaMap,
      customerEligibilityContext({
        service_area_id: resolvedAreaId,
        service_area_active: areaActive,
        region_id: regionId,
      }),
    );

    const sanitised = payload.offers.map(sanitiseOfferForApp);

    return json({
      banner: payload.banner,
      offers: sanitised,
      empty: sanitised.length === 0,
      empty_copy: payload.empty_copy,
      resolved_service_area_id: resolvedAreaId,
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
