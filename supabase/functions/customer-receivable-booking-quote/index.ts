/**
 * customer-receivable-booking-quote
 *
 * Server owns whether Previous balance may enter the Choose Ride payable CTA.
 * Fold gate OFF / not allowlisted → fold_eligible=false; debt still reported
 * for history / informational copy — never silently inflate the Book CTA.
 *
 * POST { trip_fare_pence: number, buffer_pence?: number, currency?: string }
 */
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { sumOpenReceivableOutstandingForCustomer } from "../_shared/customerReceivableLifecycle.ts";
import {
  planCustomerReceivableFoldEligibilityQuote,
  readCustomerReceivableFoldGate,
} from "../_shared/customerReceivableConsentSSOT.ts";

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

  const tripFare = Math.max(0, Math.round(Number(body.trip_fare_pence) || 0));
  const buffer = Math.max(0, Math.round(Number(body.buffer_pence) || 0));
  const currency = String(body.currency ?? "gbp").trim().toLowerCase() || "gbp";

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
  const quote = planCustomerReceivableFoldEligibilityQuote({
    customer_id: customerId,
    server_outstanding_pence: outstanding,
    trip_fare_pence: tripFare,
    buffer_pence: buffer,
    gate: frozenGate,
  });

  const informational =
    quote.outstanding_pence > 0 && !quote.fold_eligible
      ? `Outstanding balance £${(quote.outstanding_pence / 100).toFixed(2)} — it will be added to a future eligible booking.`
      : null;

  return json({
    ok: true,
    outstanding_pence: quote.outstanding_pence,
    fold_eligible: quote.fold_eligible,
    quote_version: quote.quote_version,
    trip_fare_pence: quote.trip_fare_pence,
    buffer_pence: quote.buffer_pence,
    total_authorisation_pence: quote.total_authorisation_pence,
    consent_version: quote.consent_version,
    reason: quote.reason,
    informational_copy: informational,
  });
});
