/**
 * Admin/support cancels a trip during fare negotiation — revokes offers and clears locks.
 * Requires service role (invoke from trusted admin tools only).
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!authHeader?.includes(serviceKey)) {
      return new Response(JSON.stringify({ error: "Service role required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json() as { trip_id?: string; reason?: string };
    if (!body.trip_id) {
      return new Response(JSON.stringify({ error: "trip_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      serviceKey,
    );

    const { data, error } = await supabase.rpc("admin_cancel_trip_negotiation", {
      p_trip_id: body.trip_id,
      p_reason: body.reason ?? "admin_cancelled",
    });

    if (error) {
      console.error("admin_cancel_trip_negotiation:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, result: data }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("admin-cancel-trip-negotiation:", err);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
