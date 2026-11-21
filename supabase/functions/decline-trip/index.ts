import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  corsHeaders,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  successResponse,
  errorResponse,
  logAuditEvent,
} from "../_shared/security.ts";
import {
  validateSchema,
  declineTripSchema,
  DeclineTripRequest,
} from "../_shared/validation.ts";
import { authenticateDriver } from "../_shared/driverAuth.ts";
import {
  rescueExclusiveActivationToNearby,
  SCHEDULED_ACTIVATION_EXCLUSIVE_REASON,
} from "../_shared/scheduledActivationExclusiveRescue.ts";
import { scheduleEdgeBackground } from "../_shared/scheduleEdgeBackground.ts";
import {
  createRequestId,
  finishEdgeRequestLog,
  startRequestTimer,
  withDuration,
} from "../_shared/edgeRequestTiming.ts";

// Rate limit: 50 requests per minute per IP
const RATE_LIMIT_CONFIG = { limit: 50, windowMs: 60 * 1000 };

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const clientIP = getClientIP(req);
  const userAgent = req.headers.get("user-agent") || "unknown";
  const requestId = createRequestId();
  const elapsed = startRequestTimer();

  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    console.log(`[decline-trip] Rate limit exceeded for IP: ${clientIP}`);
    return rateLimitResponse(rateLimitResult);
  }

  try {
    const authResult = await authenticateDriver(req);
    if (authResult instanceof Response) return authResult;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(
        "Invalid JSON in request body",
        400,
        undefined,
        "VALIDATION_INVALID_FORMAT",
      );
    }

    const validation = validateSchema<DeclineTripRequest>(body, declineTripSchema);
    if (!validation.success) {
      console.log(`[decline-trip] Validation failed:`, validation.errors);
      return errorResponse(
        "Validation failed",
        400,
        { validation_errors: validation.errors },
        "VALIDATION_FAILED",
      );
    }

    const { trip_id, reason } = validation.data!;
    const driver_id = authResult.driverId;

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log(`[decline-trip] Driver ${driver_id} declining trip ${trip_id}`);

    const { data: offer, error: lookupErr } = await supabase
      .from("ride_offers")
      .select("id")
      .eq("trip_id", trip_id)
      .eq("driver_id", driver_id)
      .in("status", ["pending", "offered", "countered"])
      .maybeSingle();

    if (lookupErr || !offer) {
      console.log(`[decline-trip] No active ride_offer found`);
      scheduleEdgeBackground(async () => {
        await logAuditEvent(supabase, "trip_decline_failed", {
          driverId: driver_id,
          tripId: trip_id,
          details: { reason: "offer_not_found", request_id: requestId },
          ipAddress: clientIP,
          userAgent,
        });
      }, "decline-trip-audit-not-found");
      const durationMs = elapsed();
      finishEdgeRequestLog("decline-trip", durationMs, {
        request_id: requestId,
        http_status: 404,
        trip_id,
        success: false,
        path: "offer_not_found",
      });
      // 404 is a safe client dismiss — offer already non-pending.
      return errorResponse(
        "Offer not found or already processed",
        404,
        undefined,
        "OFFER_NOT_FOUND",
      );
    }

    // Authoritative decline commit — response returns as soon as this succeeds.
    const { error: declineErr } = await supabase.rpc("decline_ride_offer", {
      p_offer_id: offer.id,
      p_driver_id: driver_id,
      p_reason: reason || null,
    });

    if (declineErr) {
      console.error("[decline-trip] decline_ride_offer RPC failed:", declineErr);
      const durationMs = elapsed();
      finishEdgeRequestLog("decline-trip", durationMs, {
        request_id: requestId,
        http_status: 500,
        trip_id,
        success: false,
        path: "decline_rpc_failed",
      });
      return errorResponse(declineErr.message, 500, undefined, "DECLINE_FAILED");
    }

    // #69A: exclusive activation rescue + audit are durable deferred work.
    // Never block the Driver dismiss path on auto-dispatch.
    scheduleEdgeBackground(async () => {
      try {
        const { data: tripRow } = await supabase
          .from("trips")
          .select(
            "id, scheduled_status, confirmed_driver_id, dispatch_mode, scheduled_ack_status",
          )
          .eq("id", trip_id)
          .maybeSingle();
        const sched = String(tripRow?.scheduled_status ?? "").trim().toLowerCase();
        const confirmed = String(tripRow?.confirmed_driver_id ?? "").trim();
        if (sched === "awaiting_activation_accept" && confirmed === driver_id) {
          const { data: gds } = await supabase
            .from("global_dispatch_settings")
            .select("max_driver_find_time_minutes")
            .eq("singleton", true)
            .maybeSingle();
          const maxFind = Math.max(
            1,
            Number(gds?.max_driver_find_time_minutes ?? 6) || 6,
          );
          const ackPending =
            String(tripRow?.scheduled_ack_status ?? "").trim().toLowerCase() ===
            "pending";
          await rescueExclusiveActivationToNearby(supabase, {
            tripId: trip_id,
            reason: ackPending
              ? SCHEDULED_ACTIVATION_EXCLUSIVE_REASON.departureAckCancelled
              : SCHEDULED_ACTIVATION_EXCLUSIVE_REASON.declinedImmediate,
            maxFindDriverMinutes: maxFind,
            supabaseUrl,
            supabaseServiceKey,
            excludeDriverId: driver_id,
            expireOpenOffers: true,
          });
        }
      } catch (rescueErr) {
        console.error("[decline-trip] exclusive activation rescue failed:", rescueErr);
      }

      await logAuditEvent(supabase, "trip_declined", {
        driverId: driver_id,
        tripId: trip_id,
        details: {
          decline_reason: reason || "not_provided",
          offer_id: offer.id,
          request_id: requestId,
        },
        ipAddress: clientIP,
        userAgent,
      });
    }, "decline-trip-post-canonical");

    const durationMs = elapsed();
    finishEdgeRequestLog("decline-trip", durationMs, {
      request_id: requestId,
      http_status: 200,
      trip_id,
      offer_id: offer.id,
      success: true,
      path: "decline_ride_offer",
    });
    return successResponse(
      withDuration(
        { declined: true, message: "Offer declined", request_id: requestId },
        durationMs,
        { source: "decline-trip", requestId },
      ),
    );
  } catch (error) {
    console.error("[decline-trip] Error:", error);
    finishEdgeRequestLog("decline-trip", elapsed(), {
      request_id: requestId,
      http_status: 500,
      success: false,
    });
    return errorResponse(
      error instanceof Error ? error.message : "Unknown error",
      500,
    );
  }
});
