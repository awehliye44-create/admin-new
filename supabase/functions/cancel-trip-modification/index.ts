import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

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

    const { requestId, reason } = await req.json();
    const expireTimeout = reason === "expired";

    console.log("Cancel trip modification request:", { requestId, reason, userId: user.id });

    if (!requestId) {
      return new Response(JSON.stringify({ error: "Missing requestId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get the modification request
    const { data: changeRequest, error: requestError } = await supabase
      .from("trip_change_requests")
      .select("*, trips(passenger_id)")
      .eq("id", requestId)
      .single();

    if (requestError || !changeRequest) {
      console.error("Request not found:", requestError);
      return new Response(JSON.stringify({ error: "Modification request not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get customer record to verify ownership (passenger_id references customers.id, not auth.users.id)
    const { data: customer } = await supabase
      .from("customers")
      .select("id, user_id")
      .eq("user_id", user.id)
      .single();

    // Verify the user is the requester (customer)
    if (!customer || changeRequest.trips.passenger_id !== customer.id) {
      return new Response(JSON.stringify({ error: "Not authorized to cancel this request" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cancellableStatuses = [
      "pending_driver_approval",
      "payment_required",
      "payment_pending",
    ];
    if (!cancellableStatuses.includes(changeRequest.status)) {
      const terminalStatus = changeRequest.status;
      if (expireTimeout && terminalStatus === "expired") {
        return new Response(JSON.stringify({
          success: true,
          requestId,
          status: "expired",
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        error: expireTimeout ? "Request cannot be expired" : "Request cannot be cancelled",
        currentStatus: terminalStatus,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (expireTimeout) {
      if (new Date(changeRequest.expires_at) > new Date()) {
        return new Response(JSON.stringify({ error: "Request has not expired yet" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const now = new Date().toISOString();
    const nextStatus = expireTimeout ? "expired" : "cancelled";

    const { error: updateError } = await supabase
      .from("trip_change_requests")
      .update({
        status: nextStatus,
        responded_at: now,
        response_by: "customer",
      })
      .eq("id", requestId);

    if (updateError) {
      console.error(`Failed to ${expireTimeout ? "expire" : "cancel"} request:`, updateError);
      return new Response(JSON.stringify({
        error: expireTimeout ? "Failed to expire request" : "Failed to cancel request",
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Modification request ${nextStatus}:`, requestId);

    return new Response(JSON.stringify({
      success: true,
      requestId,
      status: nextStatus,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Cancel trip modification error:", error);
    return new Response(JSON.stringify({ 
      error: "Internal server error",
      details: error instanceof Error ? error.message : "Unknown error"
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});