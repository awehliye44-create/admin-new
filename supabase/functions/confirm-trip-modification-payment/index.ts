import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { executeFareIncreaseModificationPayment } from "../_shared/executeFareIncreaseModificationPayment.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Idempotent retry / guest confirm surface.
 * Financial orchestration for positive deltas is owned by
 * request-trip-modification → executeFareIncreaseModificationPayment.
 * This endpoint reuses the same SSOT for retries (payment_pending / failed recover).
 */
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
      return json({ error: "Missing authorization" }, 401);
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return json({ error: "Unauthorized" }, 401);
    }

    const body = await req.json();
    const requestId = body.requestId ?? body.request_id;
    if (!requestId) {
      return json({ error: "requestId is required" }, 400);
    }

    const { data: changeRequest, error: requestError } = await supabase
      .from("trip_change_requests")
      .select("*, trips(*)")
      .eq("id", requestId)
      .single();

    if (requestError || !changeRequest) {
      return json({ error: "Modification request not found" }, 404);
    }

    const trip = changeRequest.trips as Record<string, unknown>;
    const { data: customer } = await supabase
      .from("customers")
      .select("id, user_id")
      .eq("user_id", user.id)
      .single();

    if (!customer || trip.passenger_id !== customer.id) {
      return json({ error: "Not authorized" }, 403);
    }

    const result = await executeFareIncreaseModificationPayment(supabase, {
      requestId: String(requestId),
      changeRequest,
      trip,
    });

    console.log("TRIP_MOD_PAYMENT_RESULT", {
      requestId,
      tripId: trip.id,
      success: result.success,
      status: result.status,
      paymentPhase: result.paymentPhase,
      claimCode: result.claimCode,
      tripUnchanged: result.tripUnchanged,
    });

    return json({
      success: result.success,
      requestId: result.requestId,
      status: result.status,
      paymentStatus: result.paymentStatus,
      paymentPhase: result.paymentPhase,
      paymentProcessing: result.paymentProcessing,
      tripUnchanged: result.tripUnchanged,
      alreadyConfirmed: result.alreadyConfirmed,
      alreadyApplied: result.alreadyApplied,
      claimCode: result.claimCode,
      fareDeltaPence: Number(changeRequest.fare_delta_pence ?? 0) || undefined,
      authorisedTotalPence: result.authorisedTotalPence,
      requiredPayablePence: result.requiredPayablePence,
      requiresApproval: result.requiresApproval,
      navigationImpacted: result.navigationImpacted,
      trip: result.trip,
      tripUpdated: result.tripUpdated,
      error: result.error,
      error_code: result.errorCode,
      code: result.errorCode,
      ...(result.error && !result.success ? { details: result.error } : {}),
    }, result.httpStatus);
  } catch (error) {
    console.error("confirm-trip-modification-payment error:", error);
    return json({
      error: "Internal server error",
      details: error instanceof Error ? error.message : "Unknown error",
    }, 500);
  }
});
