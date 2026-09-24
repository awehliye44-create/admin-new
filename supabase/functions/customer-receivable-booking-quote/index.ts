/**
 * customer-receivable-booking-quote
 *
 * Issues a persisted opaque booking-payment quote (payment admission SSOT).
 * Choose Ride UI must display exclusively from these fields.
 * Client never constructs or edits quote_id.
 *
 * POST {
 *   client_action_id: uuid (required — generated before quote request),
 *   trip_fare_pence: number,
 *   buffer_pence?: number,
 *   currency?: string,
 *   service_area_id?: string,
 *   ride_category?: string,
 *   vehicle_type_id?: string,
 *   pickup?: { lat, lng },
 *   dropoff?: { lat, lng },
 *   stops?: Array<{ lat, lng }>,
 *   voucher_id?: string,
 * }
 */
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { sumOpenReceivableOutstandingForCustomer } from "../_shared/customerReceivableLifecycle.ts";
import { readCustomerReceivableFoldGate } from "../_shared/customerReceivableConsentSSOT.ts";
import {
  buildBookingPaymentRouteFingerprint,
  issueBookingPaymentQuote,
  quotePublicResponseFields,
} from "../_shared/bookingPaymentQuoteSSOT.ts";

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

  const clientActionId = String(body.client_action_id ?? "").trim();
  if (!clientActionId) {
    return json({ error: "client_action_id_required", code: "BOOKING_QUOTE_INVALID" }, 400);
  }

  const tripFare = Math.max(0, Math.round(Number(body.trip_fare_pence) || 0));
  const buffer = Math.max(0, Math.round(Number(body.buffer_pence) || 0));
  const currency = String(body.currency ?? "gbp").trim().toLowerCase() || "gbp";
  const serviceAreaId = body.service_area_id != null
    ? String(body.service_area_id).trim() || null
    : null;
  const rideCategory = String(
    body.ride_category ?? body.vehicle_type_id ?? "",
  ).trim();

  const pickup = body.pickup && typeof body.pickup === "object"
    ? body.pickup as { lat?: unknown; lng?: unknown }
    : null;
  const dropoff = body.dropoff && typeof body.dropoff === "object"
    ? body.dropoff as { lat?: unknown; lng?: unknown }
    : null;
  const stops = Array.isArray(body.stops)
    ? body.stops as Array<{ lat?: unknown; lng?: unknown }>
    : [];
  const voucherId = body.voucher_id != null ? String(body.voucher_id).trim() || null : null;

  const routeFingerprint = buildBookingPaymentRouteFingerprint({
    service_area_id: serviceAreaId,
    ride_category: rideCategory,
    vehicle_type_id: typeof body.vehicle_type_id === "string" ? body.vehicle_type_id : null,
    pickup,
    dropoff,
    stops,
    voucher_id: voucherId,
    currency,
  });

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();
  const customerId = customer?.id ? String(customer.id) : null;
  if (!customerId) {
    return json({ error: "customer_not_found" }, 404);
  }

  const outstanding = await sumOpenReceivableOutstandingForCustomer(admin, {
    customer_id: customerId,
    currency,
  });
  const frozenGate = readCustomerReceivableFoldGate();

  const issued = await issueBookingPaymentQuote(admin, {
    customer_id: customerId,
    user_id: user.id,
    client_action_id: clientActionId,
    service_area_id: serviceAreaId,
    ride_category: rideCategory,
    route_fingerprint: routeFingerprint,
    currency,
    trip_fare_pence: tripFare,
    buffer_pence: buffer,
    server_outstanding_pence: outstanding,
    gate: frozenGate,
  });

  if (!issued.ok) {
    return json({
      ok: false,
      error: issued.error,
      code: "BOOKING_QUOTE_INVALID",
    }, 500);
  }

  const quote = issued.quote;
  const informational =
    quote.receivable_pence > 0 && !quote.fold_eligible
      ? `Outstanding balance £${(quote.receivable_pence / 100).toFixed(2)} — it will be added to a future eligible booking.`
      : null;

  return json({
    ...quotePublicResponseFields(quote),
    reason: quote.fold_eligible
      ? "fold_eligible"
      : (frozenGate.enabled ? "not_eligible" : "RECEIVABLE_FOLD_GATE_OFF"),
    informational_copy: informational,
    reused: issued.reused,
  });
});
