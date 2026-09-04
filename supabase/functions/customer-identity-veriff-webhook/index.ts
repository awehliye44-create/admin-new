/**
 * Legacy Veriff webhook stub.
 * Manual Admin review is the decision path — acknowledge and ignore mutations.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-hmac-signature, x-auth-client",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false }, 405);
  }

  // Soft no-op so old Veriff Station hooks do not 404.
  console.info("[customer-identity-webhook] ignored — manual review is SSOT");
  return json({
    ok: true,
    code: "IGNORED",
    message: "Veriff webhook disabled; Admin manual review decides identity.",
  });
});
