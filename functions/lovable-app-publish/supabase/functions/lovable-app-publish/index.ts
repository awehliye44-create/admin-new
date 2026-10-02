/**
 * Customer/Driver Lovable app publish — production deploy trigger.
 * Requires authenticated admin (user_roles.admin). Never callable with anon key alone.
 */
import { requireAdmin } from "../_shared/adminPaymentGate.ts";

const CUSTOMER_PROJECT_ID = "746c3b88-398a-4cbd-a1cb-0b80d568baf9";
const DRIVER_PROJECT_ID = "2543afda-4c39-4e1-a8c5-7385d68e9452";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

async function publishProject(projectId: string, token: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  let res = await fetch(`https://api.lovable.dev/v1/projects/${projectId}/deployments`, {
    method: "POST",
    headers,
    body: "{}",
  });

  if (res.status === 401 && !token.startsWith("lov_")) {
    res = await fetch(`https://api.lovable.dev/v1/projects/${projectId}/deployments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": token,
      },
      body: "{}",
    });
  }

  const body = await res.text();
  return { projectId, status: res.status, body };
}

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

  const url = new URL(req.url);
  const target = url.searchParams.get("app") ?? "all";
  const projectIds =
    target === "customer"
      ? [CUSTOMER_PROJECT_ID]
      : target === "driver"
        ? [DRIVER_PROJECT_ID]
        : [CUSTOMER_PROJECT_ID, DRIVER_PROJECT_ID];

  const results = [];
  for (const projectId of projectIds) {
    results.push(await publishProject(projectId, token));
  }

  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
