/**
 * CTAP-inflight booking identity discovery (MK-260926-007 / MK-009).
 * Authenticated read-only lookup by client_action_id — never creates a trip.
 *
 * Zero payment/wallet/trip mutations. Internal spans are observability only.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  BOOKING_CANONICAL_TRIP_LOOKUP_SELECT,
  evaluateBookingCanonicalTripLookup,
  type BookingCanonicalTripRow,
} from "../_shared/bookingCanonicalTripLookupSSOT.ts";
import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version, x-onecab-native-client, baggage, sentry-trace",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serveWithEdgeTiming("lookup-booking-canonical-trip", corsHeaders, async (req) => {
  const edgeReceiveMs = Date.now();
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, reason: "method_not_allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!anonKey) return json({ ok: false, reason: "anon_key_missing" }, 500);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ ok: false, reason: "unauthorized" }, 401);

  const authStartMs = Date.now();
  const anonClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: claimsData, error: claimsError } = await anonClient.auth.getClaims(token);
  const authEndMs = Date.now();
  if (claimsError || !claimsData?.claims?.sub) {
    return json({
      ok: false,
      reason: "unauthorized",
      timing: {
        edge_receive_ms: edgeReceiveMs,
        auth_ms: authEndMs - authStartMs,
      },
    }, 401);
  }
  const userId = String(claimsData.claims.sub);

  const body = await req.json().catch(() => ({})) as { client_action_id?: string };
  const clientActionId = String(body.client_action_id ?? "").trim();
  if (!clientActionId) {
    return json({ ok: false, reason: "missing_client_action_id" }, 400);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const customerStartMs = Date.now();
  const { data: customer, error: customerErr } = await supabase
    .from("customers")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  const customerEndMs = Date.now();
  if (customerErr || !customer?.id) {
    return json({
      ok: false,
      reason: "customer_not_found",
      timing: {
        edge_receive_ms: edgeReceiveMs,
        auth_ms: authEndMs - authStartMs,
        customer_lookup_ms: customerEndMs - customerStartMs,
      },
    }, 404);
  }

  // UNIQUE(trips.client_action_id) — O(1) identity discovery.
  const tripLookupStartMs = Date.now();
  const { data: trip, error: tripErr } = await supabase
    .from("trips")
    .select(BOOKING_CANONICAL_TRIP_LOOKUP_SELECT)
    .eq("client_action_id", clientActionId)
    .maybeSingle();
  const tripLookupEndMs = Date.now();

  if (tripErr) {
    console.warn("[lookup-booking-canonical-trip] query failed", tripErr.message);
    return json({ ok: false, reason: "lookup_failed" }, 500);
  }

  const validationStartMs = Date.now();
  const evaluated = evaluateBookingCanonicalTripLookup({
    clientActionId,
    customerId: String(customer.id),
    trip: (trip as BookingCanonicalTripRow | null) ?? null,
  });
  const validationEndMs = Date.now();
  const responseReadyMs = Date.now();

  const timing = {
    edge_receive_ms: edgeReceiveMs,
    auth_ms: authEndMs - authStartMs,
    customer_lookup_ms: customerEndMs - customerStartMs,
    trip_cai_lookup_ms: tripLookupEndMs - tripLookupStartMs,
    status_validation_ms: validationEndMs - validationStartMs,
    response_ready_ms: responseReadyMs,
    server_total_ms: responseReadyMs - edgeReceiveMs,
  };

  if (!evaluated.ok) {
    return json({
      ok: false,
      found: false,
      reason: evaluated.reason,
      client_action_id: clientActionId,
      timing,
    });
  }

  const seed = evaluated.seed;
  return json({
    ok: true,
    found: true,
    ride_id: seed.trip_id,
    trip_id: seed.trip_id,
    trip_code: seed.trip_code,
    status: seed.status,
    dispatch_status: seed.dispatch_status,
    dispatch_mode: seed.dispatch_mode,
    pickup_address: seed.pickup_address,
    dropoff_address: seed.dropoff_address,
    pickup_latitude: seed.pickup_latitude,
    pickup_longitude: seed.pickup_longitude,
    dropoff_latitude: seed.dropoff_latitude,
    dropoff_longitude: seed.dropoff_longitude,
    service_area_id: seed.service_area_id,
    vehicle_type_id: seed.vehicle_type_id,
    created_at: seed.created_at,
    searching_expires_at: seed.searching_expires_at,
    is_scheduled: seed.is_scheduled,
    scheduled_at: seed.scheduled_at,
    scheduled_status: seed.scheduled_status,
    payment_session_id: seed.payment_session_id,
    client_action_id: seed.client_action_id,
    timing,
  });
});
