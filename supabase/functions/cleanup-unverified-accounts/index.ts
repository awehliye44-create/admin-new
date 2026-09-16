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
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    if (!serviceKey) throw new Error("Missing service role key");

    const authHeader = req.headers.get("Authorization") ?? "";
    const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
    const isAuthorized = authHeader === `Bearer ${serviceKey}` || (cronSecret && authHeader === `Bearer ${cronSecret}`);
    if (!isAuthorized) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const hours = typeof body.hours === "number" ? body.hours : 24;
    const service = createClient(supabaseUrl, serviceKey);

    const { data, error } = await service.rpc("cleanup_unverified_accounts", {
      _older_than: `${hours} hours`,
    });
    if (error) throw error;

    const deletedAuth = Number((data as { deleted_auth_users?: number })?.deleted_auth_users ?? 0);
    if (deletedAuth > 0) {
      logEvent("UNVERIFIED_CUSTOMER_DELETED_AFTER_24H", { count: deletedAuth, ...data as object });
      logEvent("UNVERIFIED_DRIVER_DELETED_AFTER_24H", { count: deletedAuth, ...data as object });
    }

    return new Response(JSON.stringify({ ok: true, result: data }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("cleanup-unverified-accounts error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
