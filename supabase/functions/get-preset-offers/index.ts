/**
 * get-preset-offers
 * ------------------
 * Returns the Preset Fare Offer configuration + active offer options
 * for a given service area or trip. Consumed by the Driver App to render
 * the 3 preset offer buttons on the incoming ride card.
 *
 * Inputs (POST JSON):
 *   - service_area_id?: string
 *   - trip_id?: string  (used to look up service_area_id when not provided)
 *
 * Response shape:
 * {
 *   ok: true,
 *   offers_enabled: boolean,        // master toggle (config.is_enabled)
 *   offers_allowed_now: boolean,    // master toggle AND inside schedule window
 *   reason?: string,                // when offers_allowed_now=false
 *   config: {
 *     price_mode: 'fixed' | 'multiplier',
 *     default_selected_offer_id: string | null,
 *     countdown_enabled: boolean,
 *     countdown_seconds: number,
 *     countdown_auto_select: boolean,
 *     countdown_auto_select_offer_id: string | null,
 *   } | null,
 *   offers: Array<{
 *     id: string,
 *     offer_key: string,
 *     label: string,
 *     description: string | null,
 *     multiplier: number | null,
 *     fixed_amount_pence: number | null,
 *     icon: string | null,
 *     color: string | null,
 *     display_order: number,
 *   }>
 * }
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkOfferSchedule } from "../_shared/offerSchedule.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json().catch(() => ({}));
    let { service_area_id, trip_id } = body as {
      service_area_id?: string;
      trip_id?: string;
    };

    // Resolve service_area_id from trip_id when not provided
    if (!service_area_id && trip_id) {
      const { data: trip } = await supabase
        .from("trips")
        .select("service_area_id")
        .eq("id", trip_id)
        .maybeSingle();
      service_area_id = trip?.service_area_id ?? undefined;
    }

    if (!service_area_id) {
      return json({ ok: false, reason: "SERVICE_AREA_REQUIRED" }, 400);
    }

    // Fetch service area timezone (via region) for schedule check
    const { data: sa } = await supabase
      .from("service_areas")
      .select("id, timezone, region:regions(timezone)")
      .eq("id", service_area_id)
      .maybeSingle();

    const timezone = (sa as any)?.region?.timezone || sa?.timezone || "UTC";

    // Fetch preset offer config
    const { data: configRow } = await supabase
      .from("preset_offer_configs")
      .select("*")
      .eq("service_area_id", service_area_id)
      .maybeSingle();

    if (!configRow) {
      return json({
        ok: true,
        offers_enabled: false,
        offers_allowed_now: false,
        reason: "OFFERS_NOT_CONFIGURED",
        config: null,
        offers: [],
      });
    }

    // Schedule check (master toggle + day/time window)
    const scheduleCheck = checkOfferSchedule(configRow as any, timezone);

    // Always include offers list when configured so the Driver App can render
    // the buttons even if temporarily out-of-schedule (UI hides per offers_allowed_now).
    const { data: offersData } = await supabase
      .from("preset_offers")
      .select("id, offer_key, label, description, multiplier, fixed_amount_pence, icon, color, display_order")
      .eq("config_id", configRow.id)
      .eq("is_active", true)
      .order("display_order", { ascending: true });

    return json({
      ok: true,
      offers_enabled: scheduleCheck.offersEnabled,
      offers_allowed_now: scheduleCheck.offersAllowedNow,
      reason: scheduleCheck.reason,
      config: {
        price_mode: configRow.price_mode,
        default_selected_offer_id: configRow.default_selected_offer_id,
        countdown_enabled: configRow.countdown_enabled,
        countdown_seconds: configRow.countdown_seconds,
        countdown_auto_select: configRow.countdown_auto_select,
        countdown_auto_select_offer_id: configRow.countdown_auto_select_offer_id,
      },
      offers: offersData ?? [],
    });
  } catch (e) {
    console.error("[get-preset-offers] error", e);
    return json({ ok: false, reason: "INTERNAL_ERROR", error: String(e) }, 500);
  }
});
