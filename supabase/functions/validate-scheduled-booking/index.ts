import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";

/**
 * validate-scheduled-booking
 *
 * Called by customer/driver apps BEFORE creating a scheduled trip.
 * Validates against admin-configured rules in dispatch_settings:
 *   - scheduled_rides_enabled
 *   - min_advance_time_minutes
 *   - max_advance_days
 *
 * Body: { service_area_id: string, scheduled_at: string (ISO) }
 * Returns: { valid: true } or { valid: false, reason: string }
 */

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { service_area_id, scheduled_at } = await req.json();

    if (!service_area_id || !scheduled_at) {
      return errorResponse("service_area_id and scheduled_at are required", 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: ds, error: dsErr } = await supabase
      .from("global_dispatch_settings")
      .select("scheduled_rides_enabled, min_advance_time_minutes, max_advance_days")
      .eq("singleton", true)
      .maybeSingle();

    if (dsErr) {
      console.error("[validate-scheduled-booking] DB error:", dsErr);
      return errorResponse("Failed to load dispatch settings", 500);
    }

    if (!ds) {
      return successResponse({
        valid: false,
        reason: "No global dispatch configuration found.",
        code: "NO_CONFIG",
      });
    }

    // 1. Check scheduled_rides_enabled
    if (!ds.scheduled_rides_enabled) {
      return successResponse({
        valid: false,
        reason: "Scheduled rides are not available in this area.",
        code: "DISABLED",
      });
    }

    const scheduledDate = new Date(scheduled_at);
    const now = new Date();
    const minutesUntilPickup = (scheduledDate.getTime() - now.getTime()) / 60000;

    // 2. Check min_advance_time_minutes
    const minAdvance = ds.min_advance_time_minutes ?? 30;
    if (minutesUntilPickup < minAdvance) {
      return successResponse({
        valid: false,
        reason: `Pickup must be at least ${minAdvance} minutes from now.`,
        code: "TOO_SOON",
        min_advance_minutes: minAdvance,
      });
    }

    // 3. Check max_advance_days
    const maxDays = ds.max_advance_days ?? 30;
    const daysUntilPickup = minutesUntilPickup / 1440;
    if (daysUntilPickup > maxDays) {
      return successResponse({
        valid: false,
        reason: `Pickup cannot be more than ${maxDays} days in the future.`,
        code: "TOO_FAR",
        max_advance_days: maxDays,
      });
    }

    return successResponse({
      valid: true,
      min_advance_minutes: minAdvance,
      max_advance_days: maxDays,
    });
  } catch (err) {
    console.error("[validate-scheduled-booking] Error:", err);
    return errorResponse(err instanceof Error ? err.message : "Unknown error", 500);
  }
});
