/**
 * RETIRED — customer negotiation SSOT is customer-fare-decision.
 */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  return new Response(
    JSON.stringify({
      success: false,
      error: "DEPRECATED_ENDPOINT",
      message:
        "customer-counter-offer is retired. Use customer-fare-decision action COUNTER.",
      canonical_endpoint: "customer-fare-decision",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
