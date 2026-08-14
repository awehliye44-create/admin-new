import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { successResponse, errorResponse } from "../_shared/security.ts";

Deno.serve(async (req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const adminClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });

    const { data: recentOffers } = await adminClient.from("ride_offers")
      .select("id, trip_id, driver_id, status, expires_at, created_at")
      .order("created_at", { ascending: false })
      .limit(10);

    const { data: recentTrips } = await adminClient.from("trips")
      .select("id, status, dispatch_status, driver_id, confirmed_driver_id, created_at")
      .order("created_at", { ascending: false })
      .limit(10);

    const { data: activeDrivers } = await adminClient.from("drivers")
      .select("id, user_id, is_online, approval_status, driver_status")
      .limit(10);

    return new Response(JSON.stringify({
      ok: true,
      recentOffers,
      recentTrips,
      activeDrivers
    }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
});
