import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  fetchTripAndBroadcastUpdated,
  invokePreauthUpdateOnModification,
  upsertTripRoutePolyline,
} from "../_shared/tripModificationApply.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function isCashPaymentMethod(method: unknown): boolean {
  const m = String(method ?? "").toLowerCase();
  return m === "cash" || m === "cash_only" || m.includes("cash");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const requestId = body.requestId ?? body.request_id;
    if (!requestId) {
      return new Response(JSON.stringify({ error: "requestId is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: changeRequest, error: requestError } = await supabase
      .from("trip_change_requests")
      .select("*, trips(*)")
      .eq("id", requestId)
      .single();

    if (requestError || !changeRequest) {
      return new Response(JSON.stringify({ error: "Modification request not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const trip = changeRequest.trips as Record<string, unknown>;
    const { data: customer } = await supabase
      .from("customers")
      .select("id, user_id")
      .eq("user_id", user.id)
      .single();

    if (!customer || trip.passenger_id !== customer.id) {
      return new Response(JSON.stringify({ error: "Not authorized" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!["payment_required", "payment_pending"].includes(changeRequest.status)) {
      // Idempotent: already advanced.
      if (["pending_driver_approval", "approved", "applied"].includes(changeRequest.status)) {
        return new Response(JSON.stringify({
          success: true,
          requestId,
          status: changeRequest.status,
          paymentStatus: changeRequest.payment_status,
          requiresApproval: changeRequest.requires_approval,
          navigationImpacted: changeRequest.navigation_impacted,
          alreadyConfirmed: true,
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        error: "Request is not awaiting payment confirmation",
        currentStatus: changeRequest.status,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const fareDelta = Number(changeRequest.fare_delta_pence ?? 0);
    if (fareDelta <= 0) {
      // Should not be in payment_required, but advance safely.
      const { data: advanced, error: advanceError } = await supabase.rpc(
        "advance_trip_change_after_payment",
        { p_request_id: requestId },
      );
      if (advanceError) throw advanceError;
      return new Response(JSON.stringify({
        success: true,
        requestId,
        status: advanced?.status ?? "applied",
        paymentStatus: "not_required",
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await supabase
      .from("trip_change_requests")
      .update({ status: "payment_pending", payment_status: "pending", updated_at: new Date().toISOString() })
      .eq("id", requestId);

    const newFarePence = Number(
      changeRequest.new_fare_pence
        ?? (trip.final_customer_fare_pence as number)
        ?? (trip.estimated_total_pence as number)
        ?? 0,
    );

    try {
      if (isCashPaymentMethod(trip.payment_method)) {
        // Cash: mark increase only — no Stripe top-up.
        console.log("TRIP_MOD_PAYMENT_CASH_CONFIRMED", { requestId, tripId: trip.id, fareDelta });
      } else {
        const preauthResult = await invokePreauthUpdateOnModification(
          supabase,
          String(trip.id),
          newFarePence,
        ) as Record<string, unknown> | null;

        if (!newFarePence || newFarePence <= 0) {
          throw new Error("Payable total missing for paid trip modification");
        }

        const coverage = String(preauthResult?.payment_coverage_status ?? "");
        const success = preauthResult?.success === true && preauthResult?.skipped !== true;
        const insufficient =
          coverage === "authorization_insufficient"
          || coverage === "under_authorized"
          || coverage === "under_captured"
          || Boolean(preauthResult?.warning);

        if (!success || insufficient) {
          throw new Error(
            typeof preauthResult?.warning === "string"
              ? preauthResult.warning
              : typeof preauthResult?.error === "string"
                ? preauthResult.error
                : "Payment authorization failed for fare increase",
          );
        }

        // Fail closed: capturable/authorized must cover new payable before apply (MK-260704-002).
        const authorisedPence = Number(
          preauthResult?.authorised_amount_pence
            ?? preauthResult?.total_authorized_amount_pence
            ?? preauthResult?.amount_capturable
            ?? 0,
        );
        const capturablePence = Number(
          preauthResult?.amount_capturable ?? authorisedPence,
        );
        const coveredPence = Math.max(
          Number.isFinite(authorisedPence) ? authorisedPence : 0,
          Number.isFinite(capturablePence) ? capturablePence : 0,
        );
        if (coveredPence < newFarePence) {
          throw new Error(
            `Authorization insufficient: capturable ${coveredPence}p < payable ${newFarePence}p`,
          );
        }
      }
    } catch (payError) {
      const message = payError instanceof Error ? payError.message : String(payError);
      console.error("TRIP_MOD_PAYMENT_FAILED", { requestId, message });

      await supabase
        .from("trip_change_requests")
        .update({
          status: "payment_failed",
          payment_status: "failed",
          updated_at: new Date().toISOString(),
          rejection_reason: message,
        })
        .eq("id", requestId);

      return new Response(JSON.stringify({
        success: false,
        error: "Payment confirmation failed",
        details: message,
        status: "payment_failed",
        requestId,
      }), {
        status: 402,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Payment confirmed → driver_pending or atomic apply (via status=approved trigger).
    const { data: advanced, error: advanceError } = await supabase.rpc(
      "advance_trip_change_after_payment",
      { p_request_id: requestId },
    );

    if (advanceError) {
      console.error("TRIP_MOD_ADVANCE_FAILED", advanceError);
      await supabase
        .from("trip_change_requests")
        .update({
          status: "payment_failed",
          payment_status: "failed",
          rejection_reason: advanceError.message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId);

      return new Response(JSON.stringify({
        success: false,
        error: "Failed to apply modification after payment",
        details: advanceError.message,
        status: "payment_failed",
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const finalStatus = advanced?.status ?? "applied";
    let updatedTrip: Record<string, unknown> | null = null;
    let tripUpdated: Record<string, unknown> | null = null;

    if (finalStatus === "applied" || finalStatus === "approved") {
      const afterSnapshot = (changeRequest.after_route_snapshot ?? {}) as Record<string, unknown>;
      const farePreview = afterSnapshot.fare_preview as Record<string, unknown> | undefined;
      const polyline =
        typeof farePreview?.polyline === "string" ? farePreview.polyline : null;

      const broadcastResult = await fetchTripAndBroadcastUpdated(
        supabase,
        String(trip.id),
        polyline,
      );
      updatedTrip = broadcastResult?.trip ?? null;
      tripUpdated = broadcastResult?.payload ?? null;
      if (updatedTrip) {
        await upsertTripRoutePolyline(supabase, String(trip.id), polyline, updatedTrip);
      }
    }

    // Re-read status (apply trigger may have set applied).
    const { data: latest } = await supabase
      .from("trip_change_requests")
      .select("status, payment_status, requires_approval, navigation_impacted")
      .eq("id", requestId)
      .single();

    console.log("TRIP_MOD_PAYMENT_CONFIRMED", {
      requestId,
      tripId: trip.id,
      status: latest?.status ?? finalStatus,
      navigationImpacted: latest?.navigation_impacted,
    });

    return new Response(JSON.stringify({
      success: true,
      requestId,
      status: latest?.status ?? finalStatus,
      paymentStatus: latest?.payment_status ?? "confirmed",
      requiresApproval: latest?.requires_approval ?? false,
      navigationImpacted: latest?.navigation_impacted ?? false,
      trip: updatedTrip,
      tripUpdated,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("confirm-trip-modification-payment error:", error);
    return new Response(JSON.stringify({
      error: "Internal server error",
      details: error instanceof Error ? error.message : "Unknown error",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
