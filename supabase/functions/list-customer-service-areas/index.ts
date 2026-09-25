/**
 * list-customer-service-areas
 *
 * Thin public READ projection over the existing service_areas SSOT.
 * Returns only customer-safe fields for the WhatsApp / website booking UI.
 *
 * Does NOT create a parallel coverage source.
 * Does NOT expose financial, dispatch, payment, or polygon internals.
 *
 * Bookability = active service area in an active region (same gate as
 * resolve-service-area / whatsapp-booking-fares).
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { corsHeaders } from "../_shared/corsHeaders.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: regions, error: regionErr } = await supabase
      .from("regions")
      .select("id")
      .eq("status", "active");
    if (regionErr) throw regionErr;

    const regionIds = (regions ?? []).map((r) => String(r.id));
    if (regionIds.length === 0) {
      return new Response(
        JSON.stringify({ success: true, service_areas: [] }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data, error } = await supabase
      .from("service_areas")
      .select("id, name, display_order")
      .eq("is_active", true)
      .in("region_id", regionIds)
      .order("display_order", { ascending: true })
      .order("name", { ascending: true });

    if (error) throw error;

    const serviceAreas = (data ?? []).map((row) => ({
      id: String(row.id),
      name: String(row.name),
    }));

    return new Response(
      JSON.stringify({
        success: true,
        service_areas: serviceAreas,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[list-customer-service-areas] error:", err);
    return new Response(
      JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : "Internal server error",
        service_areas: [],
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
