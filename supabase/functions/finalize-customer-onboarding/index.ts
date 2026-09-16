import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { nativeAppCorsHeaders as corsHeaders } from "../_shared/security.ts";

function logEvent(event: string, payload: Record<string, unknown>) {
  console.log(event, JSON.stringify(payload));
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Activate Customer profile after phone OTP.
 * Phone verification is the only gate — never require Auth email confirmation.
 * Idempotent: safe to retry after timeout / kill-relaunch.
 */
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
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const anon = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const service = createClient(supabaseUrl, serviceKey);

    const { data: { user }, error: userError } = await anon.auth.getUser();
    if (userError || !user) {
      return jsonResponse({ error: "Invalid session" }, 401);
    }

    const { data: authUser } = await service.auth.admin.getUserById(user.id);
    const phoneVerified = !!authUser.user?.phone_confirmed_at;

    // Customers have no email-verification gate. Phone OTP is the only onboarding gate.
    if (!phoneVerified) {
      return jsonResponse({
        ok: false,
        reason: "pending_phone_verification",
        phone_verified: false,
        email_verified: !!authUser.user?.email_confirmed_at,
      }, 200);
    }

    const { data: customerId, error: rpcError } = await service.rpc("finalize_customer_onboarding", {
      _user_id: user.id,
    });

    if (rpcError) {
      console.error("finalize_customer_onboarding error:", rpcError);
      return jsonResponse({ error: rpcError.message }, 400);
    }

    logEvent("CUSTOMER_ACTIVATED", { user_id: user.id, customer_id: customerId });

    return jsonResponse({ ok: true, customer_id: customerId });
  } catch (err) {
    console.error("finalize-customer-onboarding error:", err);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
