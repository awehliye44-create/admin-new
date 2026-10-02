import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  handleCORSPreflight,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  isValidUUID,
  validationErrorResponse,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import {
  fetchTripAndBroadcastUpdated,
  upsertTripRoutePolyline,
} from "../_shared/tripModificationApply.ts";

/**
 * APPLY-TRIP-CHANGE
 *
 * Driver approve/reject for pending_driver_approval modifications.
 * MK-260916-030: never mutate trips fare/stops before CR→approved.
 * Approve only flips trip_change_requests.status; DB trigger
 * (apply_approved_trip_change / enforce_trip_change_payment_before_apply)
 * applies route+fare after payment evidence checks.
 */

const RATE_LIMIT_CONFIG = { limit: 30, windowMs: 60000, keyPrefix: "apply-trip-change" };

Deno.serve(async (req) => {
  console.log("[apply-trip-change] Request:", req.method);

  if (req.method === "OPTIONS") return handleCORSPreflight();

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("UNAUTHORIZED", "Please sign in again.", 401);
    }

    const anon = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await anon.auth.getUser();
    if (userError || !user) {
      return errorResponse("INVALID_SESSION", "Please sign in again.", 401);
    }

    const body = await req.json();
    const { change_request_id, driver_id: requested_driver_id, action } = body;

    const errors: Record<string, string> = {};
    if (!change_request_id) errors.change_request_id = "required";
    else if (!isValidUUID(change_request_id)) errors.change_request_id = "invalid UUID";
    if (requested_driver_id && !isValidUUID(requested_driver_id)) {
      errors.driver_id = "invalid UUID";
    }
    if (!action || !["approve", "reject"].includes(action)) {
      errors.action = "must be 'approve' or 'reject'";
    }
    if (Object.keys(errors).length > 0) return validationErrorResponse(errors);

    const { data: driverProfile, error: driverErr } = await supabase
      .from("drivers")
      .select("id")
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (driverErr || !driverProfile?.id) {
      return errorResponse("DRIVER_PROFILE_REQUIRED", "Driver profile not found.", 403);
    }

    const driver_id = driverProfile.id;
    if (requested_driver_id && requested_driver_id !== driver_id) {
      return errorResponse("FORBIDDEN", "Not authorized for this driver.", 403);
    }

    const now = new Date().toISOString();

    const { data: cr, error: crErr } = await supabase
      .from("trip_change_requests")
      .select("*")
      .eq("id", change_request_id)
      .single();

    if (crErr || !cr) {
      console.error("[apply-trip-change] Change request not found:", crErr);
      return errorResponse("NOT_FOUND", "Change request not found", 404);
    }

    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select("*")
      .eq("id", cr.trip_id)
      .single();

    if (tripErr || !trip) {
      console.error("[apply-trip-change] Trip not found:", tripErr);
      return errorResponse("NOT_FOUND", "Trip not found", 404);
    }

    const assignedDriverId = trip.confirmed_driver_id ?? trip.driver_id;
    if (!assignedDriverId || assignedDriverId !== driver_id) {
      return errorResponse("FORBIDDEN", "Not authorized for this trip", 403);
    }

    if (action === "reject") {
      const { error: rejectErr } = await supabase
        .from("trip_change_requests")
        .update({
          status: "rejected",
          responded_at: now,
          response_by: driver_id,
          rejection_reason: "Driver declined",
        })
        .eq("id", change_request_id);

      if (rejectErr) {
        console.error("[apply-trip-change] Reject error:", rejectErr);
        return errorResponse("UPDATE_FAILED", "Failed to reject", 500);
      }
      return successResponse({ success: true, action: "rejected" });
    }

    // ── APPROVE ──
    if (cr.status !== "pending_driver_approval") {
      if (cr.status === "approved" || cr.status === "applied") {
        console.log("[apply-trip-change] Already applied (idempotent)");
        return successResponse({
          success: true,
          action: "approved",
          idempotent: true,
          trip_id: cr.trip_id,
        });
      }
      return errorResponse("ALREADY_PROCESSED", `Change request is ${cr.status}`, 409);
    }

    // Effective increase gate (delta OR quoted new_fare vs committed).
    const fareDeltaApply = Number(cr.fare_delta_pence ?? 0);
    const quotedNewFarePence = Math.max(
      0,
      Math.round(Number(cr.new_fare_pence ?? 0)),
    );
    const currentCommittedPence = Math.max(
      0,
      Math.round(Number(trip.final_customer_fare_pence ?? 0)),
      Math.round(Number(trip.estimated_total_pence ?? 0)),
      Math.round(Number(trip.locked_base_fare_pence ?? 0)),
    );
    const quotedIncreasePence = quotedNewFarePence > 0
      ? Math.max(0, quotedNewFarePence - currentCommittedPence)
      : 0;
    const effectiveIncreasePence = Math.max(fareDeltaApply, quotedIncreasePence);
    const tripModel = String(
      (trip as { financial_model?: unknown }).financial_model ?? "",
    ).toUpperCase();
    const platform =
      tripModel === "PLATFORM_COLLECTED" || tripModel === "";
    const payStatus = String(cr.payment_status ?? "").toLowerCase();
    if (effectiveIncreasePence > 0) {
      if (platform && payStatus !== "confirmed") {
        return errorResponse(
          "CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED",
          "Fare-increasing modifications must complete payment authorisation before apply",
          402,
        );
      }
      if (!platform && payStatus !== "confirmed" && payStatus !== "not_required") {
        return errorResponse(
          "CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED",
          "Payment confirmation required before apply",
          402,
        );
      }
    }

    // Approve first — DB trigger applies route/fare only after payment evidence.
    // Never write trips.estimated_total / stops before this (MK-260916-030).
    const { error: approveError } = await supabase
      .from("trip_change_requests")
      .update({
        status: "approved",
        responded_at: now,
        response_by: driver_id,
      })
      .eq("id", change_request_id);

    if (approveError) {
      console.error("[apply-trip-change] Approve rejected:", approveError);
      const detail = String(approveError.message ?? approveError.details ?? "");
      if (
        detail.includes("CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED")
        || detail.includes("ADDITIONAL_AUTHORISATION_CONFIRMED")
        || detail.includes("protected=")
      ) {
        return errorResponse(
          "CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED",
          "Fare-increasing modifications must complete payment authorisation before apply",
          402,
        );
      }
      return errorResponse("UPDATE_FAILED", "Failed to approve modification", 500);
    }

    const { data: appliedRequest } = await supabase
      .from("trip_change_requests")
      .select("status, new_fare_pence, fare_delta_pence")
      .eq("id", change_request_id)
      .single();

    if (
      appliedRequest
      && appliedRequest.status !== "approved"
      && appliedRequest.status !== "applied"
    ) {
      console.error("[apply-trip-change] Approve did not apply:", appliedRequest.status);
      return errorResponse(
        "CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED",
        "Modification was not applied; payment protection may be unresolved",
        402,
      );
    }

    const afterSnapshot = (cr.after_route_snapshot ?? {}) as Record<string, unknown>;
    const farePreview = afterSnapshot.fare_preview as Record<string, unknown> | undefined;
    const polyline =
      typeof farePreview?.polyline === "string" ? farePreview.polyline : null;

    const broadcastResult = await fetchTripAndBroadcastUpdated(
      supabase,
      trip.id,
      polyline,
      { changeRequestId: change_request_id },
    );
    const updatedTrip = broadcastResult?.trip ?? null;
    if (updatedTrip) {
      await upsertTripRoutePolyline(supabase, trip.id, polyline, updatedTrip);
    }

    const farePence = Math.max(
      0,
      Math.round(
        Number(
          updatedTrip?.final_customer_fare_pence
            ?? appliedRequest?.new_fare_pence
            ?? cr.new_fare_pence
            ?? 0,
        ),
      ),
    );

    console.log("[apply-trip-change] Success — DB apply after approve", {
      status: appliedRequest?.status,
      farePence,
    });

    return successResponse({
      success: true,
      action: "approved",
      trip: updatedTrip,
      fare_pence: farePence,
      fare: farePence / 100,
      tripUpdated: broadcastResult?.payload ?? null,
    });
  } catch (error) {
    console.error("[apply-trip-change] Error:", error);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
