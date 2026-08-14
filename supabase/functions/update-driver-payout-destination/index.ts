import { createClient } from "npm:@supabase/supabase-js@2";
import { handleUpdateDriverPayoutDestination } from "../_shared/updateDriverPayoutDestinationHandler.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const destinationIdentifier = typeof body.destination_identifier === "string"
      ? body.destination_identifier
      : typeof body.account_identifier === "string"
      ? body.account_identifier
      : "";

    return await handleUpdateDriverPayoutDestination(
      supabase,
      user.id,
      {
        destination_type: typeof body.destination_type === "string" ? body.destination_type : "mobile_money",
        destination_identifier: destinationIdentifier,
        account_holder_name: typeof body.account_holder_name === "string"
          ? body.account_holder_name
          : typeof body.account_name === "string"
          ? body.account_name
          : undefined,
        device_id: typeof body.device_id === "string" ? body.device_id : undefined,
      },
      { ip_address: req.headers.get("x-forwarded-for") ?? req.headers.get("cf-connecting-ip") },
    );
  } catch (error) {
    console.error("UPDATE_DRIVER_PAYOUT_DESTINATION_FAILED", error);
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
