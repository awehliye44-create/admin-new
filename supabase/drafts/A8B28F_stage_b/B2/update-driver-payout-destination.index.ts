/**
 * A8B28F Stage B2 — drop-in entrypoint for update-driver-payout-destination.
 * Copy to: supabase/functions/update-driver-payout-destination/index.ts
 * Requires B2 shared handler + payoutDestinationVerificationOutcomeSSOT in _shared.
 * NOT DEPLOYED.
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import { handleUpdateDriverPayoutDestination } from "../_shared/updateDriverPayoutDestinationHandler.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Content-Type": "application/json",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: corsHeaders,
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
        headers: corsHeaders,
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const body = await req.json().catch(() => ({}));
    return await handleUpdateDriverPayoutDestination(supabase, user.id, body, {
      ip_address: req.headers.get("x-forwarded-for"),
    });
  } catch (err) {
    console.error("UPDATE_DRIVER_PAYOUT_DESTINATION_UNHANDLED");
    return new Response(
      JSON.stringify({
        success: false,
        outcome: "DESTINATION_SAVE_FAILED",
        message: "Could not save your payout account. Please try again.",
      }),
      { status: 500, headers: corsHeaders },
    );
  }
});
