import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  errorResponse,
  successResponse,
  checkRateLimit,
  rateLimitResponse,
} from "../_shared/security.ts";

const RATE_LIMIT = { limit: 60, windowMs: 60_000 };

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let body: {
      action: "start" | "tick" | "stop" | "restore";
      driver_id: string;
      trip_id?: string;
      stop_id?: string;
      waiting_id?: string;
    };

    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON", 400);
    }

    const { action, driver_id } = body;

    if (!action || !driver_id) {
      return errorResponse("Missing action or driver_id", 400);
    }

    const rl = checkRateLimit(`sw:${driver_id}`, RATE_LIMIT);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfter!);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    switch (action) {
      case "start": {
        if (!body.trip_id || !body.stop_id) {
          return errorResponse("Missing trip_id or stop_id for start", 400);
        }

        // Get dispatch settings for this trip's service area
        const { data: trip } = await supabase
          .from("trips")
          .select("service_area_id")
          .eq("id", body.trip_id)
          .single();

        let gracePeriod = 0;
        let chargeInterval = 10;
        let ratePence = 30;

        if (trip?.service_area_id) {
          const { data: ds } = await supabase
            .from("dispatch_settings")
            .select("stop_waiting_grace_period_seconds, stop_waiting_charge_interval_seconds, stop_waiting_rate_pence_per_minute")
            .eq("service_area_id", trip.service_area_id)
            .maybeSingle();

          if (ds) {
            gracePeriod = ds.stop_waiting_grace_period_seconds ?? 0;
            chargeInterval = ds.stop_waiting_charge_interval_seconds ?? 10;
            ratePence = ds.stop_waiting_rate_pence_per_minute ?? 30;
          } else {
            // Fallback to global settings
            const { data: globalDs } = await supabase
              .from("dispatch_settings")
              .select("stop_waiting_grace_period_seconds, stop_waiting_charge_interval_seconds, stop_waiting_rate_pence_per_minute")
              .is("service_area_id", null)
              .maybeSingle();

            if (globalDs) {
              gracePeriod = globalDs.stop_waiting_grace_period_seconds ?? 0;
              chargeInterval = globalDs.stop_waiting_charge_interval_seconds ?? 10;
              ratePence = globalDs.stop_waiting_rate_pence_per_minute ?? 30;
            }
          }
        }

        const { data: waitingId, error } = await supabase.rpc("start_stop_waiting", {
          p_trip_id: body.trip_id,
          p_stop_id: body.stop_id,
          p_driver_id: driver_id,
          p_grace_period_seconds: gracePeriod,
          p_charge_interval_seconds: chargeInterval,
          p_rate_pence_per_minute: ratePence,
        });

        if (error) {
          console.error("[stop-waiting] start error:", error);
          return errorResponse(error.message, 400);
        }

        return successResponse({
          waiting_id: waitingId,
          grace_period_seconds: gracePeriod,
          charge_interval_seconds: chargeInterval,
          rate_pence_per_minute: ratePence,
        });
      }

      case "tick": {
        if (!body.waiting_id) {
          return errorResponse("Missing waiting_id for tick", 400);
        }

        const { data, error } = await supabase.rpc("tick_stop_waiting", {
          p_waiting_id: body.waiting_id,
        });

        if (error) {
          console.error("[stop-waiting] tick error:", error);
          return errorResponse(error.message, 500);
        }

        return successResponse(data);
      }

      case "stop": {
        if (!body.waiting_id) {
          return errorResponse("Missing waiting_id for stop", 400);
        }

        const { data, error } = await supabase.rpc("stop_stop_waiting", {
          p_waiting_id: body.waiting_id,
        });

        if (error) {
          console.error("[stop-waiting] stop error:", error);
          return errorResponse(error.message, 500);
        }

        return successResponse(data);
      }

      case "restore": {
        const { data, error } = await supabase.rpc("get_active_stop_waiting", {
          p_driver_id: driver_id,
        });

        if (error) {
          console.error("[stop-waiting] restore error:", error);
          return errorResponse(error.message, 500);
        }

        return successResponse(data);
      }

      default:
        return errorResponse(`Unknown action: ${action}`, 400);
    }
  } catch (err) {
    console.error("[stop-waiting] Error:", err);
    return errorResponse(err instanceof Error ? err.message : "Unknown error", 500);
  }
});
