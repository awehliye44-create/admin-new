/**
 * customer-receivable-booking-quote
 *
 * Issues a persisted opaque booking-payment quote (payment admission SSOT).
 * Choose Ride UI must display exclusively from these fields.
 * Client never constructs or edits quote_id.
 *
 * The preauth buffer is server-owned (service_area_preauth_settings).
 * Any client-supplied buffer_pence is ignored.
 *
 * POST {
 *   client_action_id: uuid (required — generated before quote request),
 *   trip_fare_pence: number,
 *   currency?: string,
 *   service_area_id: string (required, must be an active service area),
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
  issueBookingPaymentQuote,
  parseBookingQuoteRequestBody,
  quotePublicResponseFields,
  resolveBookingQuoteServerBuffer,
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

  const fields = parseBookingQuoteRequestBody(body);
  if (!fields.client_action_id) {
    return json({ error: "client_action_id_required", code: "BOOKING_QUOTE_INVALID" }, 400);
  }
  if (!fields.service_area_id) {
    return json({ error: "service_area_id_required", code: "BOOKING_QUOTE_INVALID" }, 400);
  }

  const admin = createClient(supabaseUrl, serviceKey);
  const [{ data: customer }, { data: serviceArea }] = await Promise.all([
    admin.from("customers").select("id").eq("user_id", user.id).maybeSingle(),
    admin.from("service_areas").select("id, is_active").eq("id", fields.service_area_id)
      .maybeSingle(),
  ]);
  const customerId = customer?.id ? String(customer.id) : null;
  if (!customerId) {
    return json({ error: "customer_not_found" }, 404);
  }
  if (!serviceArea || serviceArea.is_active === false) {
    return json({ error: "service_area_invalid", code: "BOOKING_QUOTE_INVALID" }, 400);
  }

  const [outstanding, serverBuffer] = await Promise.all([
    sumOpenReceivableOutstandingForCustomer(admin, {
      customer_id: customerId,
      currency: fields.currency,
    }),
    resolveBookingQuoteServerBuffer(admin, fields),
  ]);
  const frozenGate = readCustomerReceivableFoldGate();

  const issued = await issueBookingPaymentQuote(admin, {
    customer_id: customerId,
    user_id: user.id,
    client_action_id: fields.client_action_id,
    service_area_id: fields.service_area_id,
    ride_category: fields.ride_category,
    route_fingerprint: fields.route_fingerprint,
    currency: fields.currency,
    trip_fare_pence: fields.trip_fare_pence,
    server_buffer: serverBuffer,
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
