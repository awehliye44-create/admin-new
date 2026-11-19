import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  buildProgressView,
  selectHomeCampaign,
  type DriverTripBonusCampaignRow,
  type DriverTripBonusGeoContext,
} from "../_shared/driverTripBonusCampaignSSOT.ts";

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
 * Driver Home trip-bonus progress card payload.
 * One highest-priority live campaign for the driver's service area.
 * Eligibility resolved on the backend — app never filters by city text.
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
      .select("id, service_area_id")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (driverErr) throw driverErr;
    if (!driver) return json({ error: "DRIVER_PROFILE_REQUIRED" }, 403);

    let areaActive = false;
    let driverRegionId: string | null = null;
    if (driver.service_area_id) {
      const { data: area, error: areaErr } = await admin
        .from("service_areas")
        .select("id, is_active, region_id")
        .eq("id", driver.service_area_id)
        .maybeSingle();
      if (areaErr) throw areaErr;
      areaActive = area?.is_active === true;
      driverRegionId = areaActive ? (area?.region_id ?? null) : null;
    }

    const geo: DriverTripBonusGeoContext = {
      service_area_id: driver.service_area_id ?? null,
      service_area_active: areaActive,
      region_id: driverRegionId,
    };

    const { data: campaigns, error: campErr } = await admin
      .from("driver_trip_bonus_campaigns")
      .select(
        "id, title, card_headline, card_body, trip_target, bonus_amount_pence, status, is_active, starts_at, ends_at, scope_type, region_id, display_priority, created_at",
      )
      .eq("status", "published")
      .eq("is_active", true);
    if (campErr) throw campErr;

    const rows = (campaigns ?? []) as DriverTripBonusCampaignRow[];
    const areaMap: Record<string, string[]> = {};
    if (rows.length && driver.service_area_id && areaActive) {
      const { data: links, error: linkErr } = await admin
        .from("driver_trip_bonus_campaign_service_areas")
        .select("campaign_id, service_area_id")
        .in(
          "campaign_id",
          rows.map((r) => r.id),
        )
        .eq("service_area_id", driver.service_area_id);
      if (linkErr) throw linkErr;
      for (const l of (links ?? []) as Array<{ campaign_id: string; service_area_id: string }>) {
        (areaMap[l.campaign_id] ??= []).push(l.service_area_id);
      }
    }

    const home = selectHomeCampaign(rows, areaMap, geo);
    if (!home) {
      return json({ campaign: null });
    }

    const { data: progress } = await admin
      .from("driver_trip_bonus_campaign_progress")
      .select("completed_count, credited_at")
      .eq("campaign_id", home.id)
      .eq("driver_id", driver.id)
      .maybeSingle();

    const completed = Number(progress?.completed_count ?? 0);
    const credited = progress?.credited_at != null;
    const view = buildProgressView(home, completed, credited);

    // Hide card once credited — progress goal is done.
    if (view.credited) {
      return json({ campaign: null });
    }

    return json({
      campaign: {
        campaign_id: view.campaign_id,
        title: view.title,
        card_headline: view.card_headline,
        card_body: view.card_body,
        trip_target: view.trip_target,
        completed_count: view.completed_count,
        remaining_trips: view.remaining_trips,
        bonus_amount_pence: view.bonus_amount_pence,
        progress_ratio: view.progress_ratio,
        // Sticky Home card: Driver hides locally after ends_at while offline.
        ends_at: home.ends_at ?? null,
      },
    });
  } catch (e) {
    console.error("[driver-trip-bonus-progress]", e);
    return json({ error: "INTERNAL" }, 500);
  }
});
