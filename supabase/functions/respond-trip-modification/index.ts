import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  fetchTripAndBroadcastUpdated,
  upsertTripRoutePolyline,
} from "../_shared/tripModificationApply.ts";
import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Helper to send push notification to customer
async function notifyCustomer(
  supabaseUrl: string,
  supabaseKey: string,
  passengerId: string,
  title: string,
  body: string,
  tripId: string,
) {
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        userId: passengerId,
        title,
        body,
        tripId,
        url: "/ride-tracking",
        tag: "trip-modification",
      }),
    });
    if (!response.ok) {
      console.warn("Push notification failed:", await response.text());
    }
  } catch (err) {
    console.warn("Error sending push notification:", err);
  }
}

interface ResponseRequest {
  requestId: string;
  action: "approve" | "reject";
  rejectionReason?: string;
}

serveWithEdgeTiming("respond-trip-modification", corsHeaders, async (req) => {

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Get user token for auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create client with user's token for RLS
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // Create service role client for operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get the authenticated user
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      console.error("Auth error:", userError);
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body: ResponseRequest = await req.json();
    const { requestId, action, rejectionReason } = body;

    console.log("Trip modification response:", { requestId, action, userId: user.id });

    if (!requestId || !action) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!["approve", "reject"].includes(action)) {
      return new Response(JSON.stringify({ error: "Invalid action" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get the modification request
    const { data: changeRequest, error: requestError } = await supabase
      .from("trip_change_requests")
      .select("*, trips(*)")
      .eq("id", requestId)
      .single();

    if (requestError || !changeRequest) {
      console.error("Request not found:", requestError);
      return new Response(JSON.stringify({ error: "Modification request not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify the user is the driver for this trip
    const { data: driver } = await supabase
      .from("drivers")
      .select("id")
      .eq("user_id", user.id)
      .single();

    if (!driver || changeRequest.trips.driver_id !== driver.id) {
      return new Response(JSON.stringify({ error: "Not authorized to respond to this request" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Driver approval only for navigation-impacting requests awaiting driver.
    if (changeRequest.status !== "pending_driver_approval") {
      return new Response(JSON.stringify({ 
        error: "Request is no longer pending",
        currentStatus: changeRequest.status 
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!changeRequest.navigation_impacted && !changeRequest.requires_approval) {
      return new Response(JSON.stringify({
        error: "This modification does not require driver approval",
        currentStatus: changeRequest.status,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Payment must be confirmed before driver can approve a fare-increasing mod.
    const fareDelta = Number(changeRequest.fare_delta_pence ?? 0);
    if (fareDelta > 0 && changeRequest.payment_status !== "confirmed") {
      return new Response(JSON.stringify({
        error: "Payment confirmation required before driver approval",
        currentStatus: changeRequest.status,
        paymentStatus: changeRequest.payment_status,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if request has expired
    if (new Date(changeRequest.expires_at) < new Date()) {
      // Mark as expired
      await supabase
        .from("trip_change_requests")
        .update({ status: "expired", updated_at: new Date().toISOString() })
        .eq("id", requestId);

      return new Response(JSON.stringify({ error: "Request has expired" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const trip = changeRequest.trips;
    const now = new Date().toISOString();

    if (action === "reject") {
      // Update request status to rejected
      const { error: updateError } = await supabase
        .from("trip_change_requests")
        .update({
          status: "rejected",
          responded_at: now,
          response_by: "driver",
          rejection_reason: rejectionReason || null,
        })
        .eq("id", requestId);

      if (updateError) {
        console.error("Failed to reject request:", updateError);
        return new Response(JSON.stringify({ error: "Failed to update request" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log("Modification request rejected:", requestId);

      // Send push notification to customer about rejection
      if (trip.passenger_id) {
        notifyCustomer(
          supabaseUrl, supabaseServiceKey,
          trip.passenger_id,
          "❌ Modification Rejected",
          rejectionReason ? `Driver declined: ${rejectionReason}` : "Driver declined your route change request",
          trip.id,
        );
      }

      return new Response(JSON.stringify({
        success: true,
        action: "rejected",
        requestId,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // APPROVE - Apply the modification atomically
    const afterSnapshot = changeRequest.after_route_snapshot;
    const changeType = changeRequest.change_type;

    // Apply changes via DB trigger (apply_approved_trip_change fires on status → approved)
    try {
      // Update the modification request status — the DB trigger handles all data changes
      const { error: approveError } = await supabase
        .from("trip_change_requests")
        .update({
          status: "approved",
          responded_at: now,
          response_by: "driver",
        })
        .eq("id", requestId);

      if (approveError) {
        throw approveError;
      }

      // Payment was confirmed before driver_pending; apply is atomic via DB trigger.
      // Re-read status (trigger sets applied).
      const { data: appliedRequest } = await supabase
        .from("trip_change_requests")
        .select("status")
        .eq("id", requestId)
        .single();

      console.log("TRIP_MODIFICATION_APPROVED", {
        appliedStatus: appliedRequest?.status,
        requestId,
        tripId: trip.id,
        changeType,
        fareDeltaPence: changeRequest.fare_delta_pence,
        newFarePence: changeRequest.new_fare_pence,
      });

      const afterSnapshot = (changeRequest.after_route_snapshot ?? {}) as Record<string, unknown>;
      const farePreview = afterSnapshot.fare_preview as Record<string, unknown> | undefined;
      const polyline =
        typeof farePreview?.polyline === "string" ? farePreview.polyline : null;

      const broadcastResult = await fetchTripAndBroadcastUpdated(supabase, trip.id, polyline);
      const updatedTrip = broadcastResult?.trip ?? null;

      if (updatedTrip) {
        await upsertTripRoutePolyline(supabase, trip.id, polyline, updatedTrip);
      }

      // Send push notification to customer about approval
      if (trip.passenger_id) {
        const changeLabels: Record<string, string> = {
          add_stop: "Stop added",
          remove_stop: "Stop removed",
          change_dropoff: "Dropoff changed",
          reorder_stops: "Stops reordered",
        };
        const label = changeLabels[changeType] || "Route updated";
        notifyCustomer(
          supabaseUrl, supabaseServiceKey,
          trip.passenger_id,
          "✅ Route Updated!",
          `${label} — your trip has been updated`,
          trip.id,
        );
      }

      return new Response(JSON.stringify({
        success: true,
        action: "approved",
        requestId,
        trip: updatedTrip ?? null,
        tripUpdated: broadcastResult?.payload ?? null,
        newFare: updatedTrip?.fare ?? updatedTrip?.estimated_fare ?? (changeRequest.new_fare_pence ? changeRequest.new_fare_pence / 100 : null),
        fareDelta: changeRequest.fare_delta_pence ? changeRequest.fare_delta_pence / 100 : 0,
        updatedAt: updatedTrip?.updated_at ?? null,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    } catch (applyError) {
      console.error("Failed to apply modification:", applyError);
      
      // Rollback: mark request as rejected due to error
      await supabase
        .from("trip_change_requests")
        .update({
          status: "rejected",
          responded_at: now,
          response_by: "system",
          rejection_reason: "Failed to apply changes",
        })
        .eq("id", requestId);

      return new Response(JSON.stringify({ 
        error: "Failed to apply modification",
        details: applyError instanceof Error ? applyError.message : "Unknown error"
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

  } catch (error) {
    console.error("Trip modification response error:", error);
    return new Response(JSON.stringify({ 
      error: "Internal server error",
      details: error instanceof Error ? error.message : "Unknown error"
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});