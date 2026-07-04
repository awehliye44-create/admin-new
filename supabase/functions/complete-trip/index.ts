/**
 * RETIRED — trip completion SSOT is stop-workflow action complete_trip.
 * Admin force-complete uses admin-trip-action.
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
        "complete-trip is retired. Drivers use stop-workflow action complete_trip. Admins use admin-trip-action force_complete.",
      canonical_endpoint: "stop-workflow",
      admin_canonical_endpoint: "admin-trip-action",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
