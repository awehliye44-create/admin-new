/**
 * Admin Lovable publish — production deploy trigger.
 * Requires authenticated admin (user_roles.admin). Never callable with anon key alone.
 */
import { requireAdmin } from "../_shared/adminPaymentGate.ts";

const LOVABLE_PROJECT_ID = "235162d5-c07d-4b9e-aa0c-c563bcb252a2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;

  const token = Deno.env.get("LOVABLE_API_KEY");
  if (!token) {
    return new Response(JSON.stringify({ error: "LOVABLE_API_KEY not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Lovable-API-Key": token,
  };

  let res = await fetch(`https://api.lovable.dev/v1/projects/${LOVABLE_PROJECT_ID}/deployments`, {
    method: "POST",
    headers,
    body: "{}",
  });

  if (res.status === 401 && !token.startsWith("lov_")) {
    res = await fetch(`https://api.lovable.dev/v1/projects/${LOVABLE_PROJECT_ID}/deployments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "{}",
    });
  }

  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
