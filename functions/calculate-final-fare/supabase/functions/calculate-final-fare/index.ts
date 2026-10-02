/**
 * RETIRED — fare mutation SSOT is request-trip-modification + stop-workflow
 * waiting finalization + finalize-trip-and-capture.
 * Ungated destination/waiting fare writes blocked (MK-260916-030).
 */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
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
        "calculate-final-fare is retired. Use request-trip-modification for route/fare changes and stop-workflow / finalize-trip-and-capture for waiting settlement.",
      canonical_endpoint: "request-trip-modification",
      waiting_canonical_endpoint: "stop-workflow",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
