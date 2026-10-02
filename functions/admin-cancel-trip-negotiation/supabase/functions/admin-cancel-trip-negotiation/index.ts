/**
 * Admin/support cancels a trip during fare negotiation — revokes offers and clears locks.
 * Requires service role (invoke from trusted admin tools only).
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { notifyCustomerTripLifecycle } from "../_shared/customerTripLifecycleNotify.ts";

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

    const rpcResult = data as { success?: boolean; cancelled?: boolean } | null;
    const { data: tripRow } = await supabase
      .from("trips")
      .select("status, passenger_id")
      .eq("id", body.trip_id)
      .maybeSingle();
    const status = String(tripRow?.status ?? "").toLowerCase();
    const passengerId =
      typeof tripRow?.passenger_id === "string" ? tripRow.passenger_id.trim() : "";
    const didCancel =
      rpcResult?.cancelled === true ||
      status === "cancelled" ||
      status === "canceled";
    if (didCancel && passengerId) {
      void notifyCustomerTripLifecycle(supabase, {
        passengerId,
        tripId: body.trip_id,
        event: "trip_cancelled",
        title: "ONECAB TRIP CANCELLED",
        body: "Your trip has been cancelled.",
        notificationId: `trip_cancelled-${body.trip_id}-admin_negotiation_cancel`,
      }).catch((e) =>
        console.warn(
          "[admin-cancel-trip-negotiation] customer trip_cancelled push failed:",
          e,
        )
      );
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
