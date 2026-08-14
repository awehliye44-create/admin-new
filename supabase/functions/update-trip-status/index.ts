/**
 * RETIRED — trip lifecycle SSOT is stop-workflow.
 * Direct status mutation is blocked (FULL SSOT).
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
        "update-trip-status is retired. Use stop-workflow actions: arrive_pickup, start_trip, arrive_stop, drive_to_next, complete_trip.",
      canonical_endpoint: "stop-workflow",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
