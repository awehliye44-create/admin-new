import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function logEvent(event: string, payload: Record<string, unknown>) {
  console.log(event, JSON.stringify(payload));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anon = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const service = createClient(supabaseUrl, serviceKey);

    const { data: { user }, error: userError } = await anon.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: authUser } = await service.auth.admin.getUserById(user.id);
    const emailVerified = !!authUser.user?.email_confirmed_at;
    const phoneVerified = !!authUser.user?.phone_confirmed_at;

    if (!emailVerified || !phoneVerified) {
      return new Response(JSON.stringify({
        ok: false,
        reason: "pending_verification",
        email_verified: emailVerified,
        phone_verified: phoneVerified,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: customerId, error: rpcError } = await service.rpc("finalize_customer_onboarding", {
      _user_id: user.id,
    });

    if (rpcError) {
      console.error("finalize_customer_onboarding error:", rpcError);
      return new Response(JSON.stringify({ error: rpcError.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logEvent("CUSTOMER_ACTIVATED", { user_id: user.id, customer_id: customerId });

    return new Response(JSON.stringify({ ok: true, customer_id: customerId }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("finalize-customer-onboarding error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
