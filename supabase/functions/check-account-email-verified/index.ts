import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { resolveVerificationAppType } from "../_shared/accountEmailVerification.ts";
import { nativeAppCorsHeaders as corsHeaders } from "../_shared/security.ts";

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
      return new Response(JSON.stringify({ verified: false, error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anon = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await anon.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ verified: false, error: "Invalid session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (user.email_confirmed_at) {
      return new Response(JSON.stringify({ verified: true, source: "auth" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const appType = resolveVerificationAppType(body.app_type);

    const service = createClient(supabaseUrl, serviceKey);
    const { data: row, error } = await service
      .from("account_email_verifications")
      .select("verified_at")
      .eq("user_id", user.id)
      .eq("app_type", appType)
      .not("verified_at", "is", null)
      .order("verified_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("check-account-email-verified lookup error:", error);
      return new Response(JSON.stringify({ verified: false, error: "Lookup failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ verified: !!row?.verified_at, source: "token_row" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("check-account-email-verified error:", err);
    return new Response(JSON.stringify({ verified: false, error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
