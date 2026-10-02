/**
 * RETIRED — arrive-at-pickup SSOT is stop-workflow action arrive_pickup.
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
        "driver-arrived is retired. Use stop-workflow action arrive_pickup (driver app) or admin-trip-action.",
      canonical_endpoint: "stop-workflow",
      admin_canonical_endpoint: "admin-trip-action",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
