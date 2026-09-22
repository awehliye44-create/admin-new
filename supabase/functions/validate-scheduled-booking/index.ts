import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  corsHeaders,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import { findPassengerScheduleOverlap } from "../_shared/passengerScheduleOverlapSSOT.ts";

/**
 * validate-scheduled-booking
 *
 * Called by customer apps BEFORE creating a scheduled trip.
 * Validates against admin-configured rules in dispatch_settings:
 *   - scheduled_rides_enabled
 *   - min_advance_time_minutes  (advance only — NOT overlap)
 *   - max_advance_days
 * Plus passenger expected-interval overlap (reuse corporate window math).
 *
 * Body: {
 *   service_area_id: string,
 *   scheduled_at: string (ISO),
 *   estimated_duration_minutes?: number
 * }
 */

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const service_area_id = body?.service_area_id;
    const scheduled_at = body?.scheduled_at;
    const durationMinutes = Math.max(
      1,
      Number(body?.estimated_duration_minutes ?? 30),
    );

    if (!service_area_id || !scheduled_at) {
      return errorResponse("service_area_id and scheduled_at are required", 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

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

    const minAdvance = ds.min_advance_time_minutes ?? 30;
    if (minutesUntilPickup < minAdvance) {
      return successResponse({
        valid: false,
        reason: `Pickup must be at least ${minAdvance} minutes from now.`,
        code: "TOO_SOON",
        min_advance_minutes: minAdvance,
      });
    }

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

    // Passenger overlap — best-effort when JWT present (CTAP is authoritative).
    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (bearer && bearer !== serviceKey && bearer !== anonKey) {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${bearer}` } },
      });
      const { data: userData } = await userClient.auth.getUser();
      const userId = userData?.user?.id ?? null;
      if (userId) {
        const { data: existing, error: ovErr } = await supabase
          .from("trips")
          .select(
            "id, scheduled_at, estimated_duration_minutes, status, passenger_id, created_at, is_scheduled",
          )
          .eq("passenger_id", userId)
          .limit(200);
        if (ovErr) {
          console.error("[validate-scheduled-booking] overlap query failed:", ovErr);
          return errorResponse("Unable to check booking time conflict", 500);
        }
        const overlap = findPassengerScheduleOverlap({
          candidateScheduledAt: scheduled_at,
          candidateDurationMinutes: durationMinutes,
          existing: existing ?? [],
          nowMs: now.getTime(),
        });
        if (overlap.has_conflict) {
          return successResponse({
            valid: false,
            reason: "Booking time conflict",
            code: "BOOKING_TIME_CONFLICT",
            conflicting_trip_id: overlap.conflicting_trip_id,
            conflicting_time: overlap.conflicting_time,
            min_advance_minutes: minAdvance,
            max_advance_days: maxDays,
          });
        }
      }
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
