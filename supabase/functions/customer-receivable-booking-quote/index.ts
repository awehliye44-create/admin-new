/**
 * customer-receivable-booking-quote
 *
 * Issues a persisted opaque booking-payment quote (payment admission SSOT).
 * Choose Ride UI must display exclusively from these fields.
 * Client never constructs or edits quote_id.
 *
 * Fare authority: the server fare artifact (server_fare_quotes, written by
 * calculate-fare from a calculate-route artifact via pricing-engine.ts).
 * trip_fare_pence = artifact gross − server-resolved discount; the preauth
 * buffer is resolved server-side on that payable.
 * Any client trip_fare_pence / buffer_pence / discount is ignored.
 *
 * POST {
 *   client_action_id: uuid (required — generated before quote request),
 *   service_area_id: string (required, must equal the artifact's server SA),
 *   vehicle_type_id: string (required),
 *   pickup: { lat, lng }, dropoff: { lat, lng }, stops?: Array<{ lat, lng }>,
 *   server_fare_quote_id?: uuid (opaque; otherwise newest artifact for route+vehicle),
 *   personal_voucher_code?: string (validated server-side),
 *   currency?, ride_category?, voucher_id?,
 *   trip_fare_pence?: number (diagnostics only — never priced),
 * }
 */
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { issueServerAuthoritativeBookingQuote } from "../_shared/serverBookingQuoteIssue.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json({ error: "server_misconfigured" }, 500);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const admin = createClient(supabaseUrl, serviceKey);
  const result = await issueServerAuthoritativeBookingQuote(admin, { userId: user.id, body });
  return json(result.body, result.status);
});
