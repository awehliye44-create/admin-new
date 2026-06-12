// Customer counter-offer edge function.
// The customer mobile app calls this to submit a one-time counter fare
// in response to a driver's offer. Writes ride_offers.customer_counter_fare
// under service-role privileges so direct UPDATE RLS isn't required.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  successResponse,
  errorResponse,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  logAuditEvent,
} from "../_shared/security.ts";

const RATE_LIMIT_CONFIG = { limit: 30, windowMs: 60 * 1000 };

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const clientIP = getClientIP(req);
  const userAgent = req.headers.get("user-agent") || "unknown";

  const rl = checkRateLimit(`counter-offer:${clientIP}`, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter!);

  try {
    // ----- Auth: customer JWT -----
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Missing authorization header", 401, undefined, "AUTH_MISSING");
    }
    const anon = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const token = authHeader.replace("Bearer ", "");
    const { data: claims, error: claimsErr } = await anon.auth.getClaims(token);
    if (claimsErr || !claims?.claims) {
      return errorResponse("Invalid or expired token", 401, undefined, "AUTH_INVALID");
    }
    const userId = claims.claims.sub as string;

    // ----- Parse body -----
    let body: { trip_id?: string; offer_id?: string; counter_fare_pence?: number };
    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON in request body", 400, undefined, "VALIDATION_INVALID_FORMAT");
    }

    const trip_id = body.trip_id?.trim();
    const offer_id = body.offer_id?.trim();
    const counter_fare_pence = Number(body.counter_fare_pence);

    if (!trip_id || !offer_id) {
      return errorResponse("trip_id and offer_id are required", 400, undefined, "VALIDATION_FAILED");
    }
    if (!Number.isFinite(counter_fare_pence) || counter_fare_pence <= 0) {
      return errorResponse("counter_fare_pence must be a positive integer", 400, undefined, "VALIDATION_FAILED");
    }

    // ----- Service client (bypass RLS for verified writes) -----
    const svc = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Resolve customer.id from auth user
    const { data: customer, error: custErr } = await svc
      .from("customers")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();
    if (custErr || !customer) {
      return errorResponse("Customer profile not found", 403, undefined, "CUSTOMER_NOT_FOUND");
    }

    // Verify trip ownership
    const { data: trip, error: tripErr } = await svc
      .from("trips")
      .select("id, customer_id, status")
      .eq("id", trip_id)
      .maybeSingle();
    if (tripErr || !trip) {
      return errorResponse("Trip not found", 404, undefined, "TRIP_NOT_FOUND");
    }
    if (trip.customer_id !== customer.id) {
      return errorResponse("Forbidden: not your trip", 403, undefined, "TRIP_FORBIDDEN");
    }

    // Load the offer
    const { data: offer, error: offerErr } = await svc
      .from("ride_offers")
      .select(
        "id, trip_id, status, driver_offer_fare, customer_counter_fare, customer_respond_by, offer_options, expires_at",
      )
      .eq("id", offer_id)
      .maybeSingle();
    if (offerErr || !offer) {
      return errorResponse("Offer not found", 404, undefined, "OFFER_NOT_FOUND");
    }
    if (offer.trip_id !== trip_id) {
      return errorResponse("Offer does not belong to this trip", 400, undefined, "OFFER_TRIP_MISMATCH");
    }
    if (offer.status !== "pending" && offer.status !== "offered") {
      return errorResponse(`Offer is ${offer.status}, cannot counter`, 409, undefined, "OFFER_NOT_PENDING");
    }
    if (offer.customer_counter_fare && offer.customer_counter_fare > 0) {
      return errorResponse("Counter offer already submitted", 409, undefined, "COUNTER_ALREADY_SUBMITTED");
    }
    if (new Date(offer.expires_at).getTime() < Date.now()) {
      return errorResponse("Offer has expired", 410, undefined, "OFFER_EXPIRED");
    }

    // Validate amount: must be one of the allowed offer_options when present,
    // otherwise must be strictly less than the driver's offered fare.
    const opts = Array.isArray(offer.offer_options) ? offer.offer_options : [];
    if (opts.length > 0 && !opts.includes(counter_fare_pence)) {
      return errorResponse(
        "counter_fare_pence is not one of the allowed preset options",
        400,
        { allowed: opts },
        "COUNTER_AMOUNT_NOT_ALLOWED",
      );
    }
    if (opts.length === 0 && offer.driver_offer_fare && counter_fare_pence >= offer.driver_offer_fare) {
      return errorResponse(
        "Counter must be lower than the driver's offered fare",
        400,
        undefined,
        "COUNTER_AMOUNT_TOO_HIGH",
      );
    }

    // Write counter
    const { error: updErr } = await svc
      .from("ride_offers")
      .update({
        customer_counter_fare: counter_fare_pence,
        negotiation_status: "customer_countered",
        updated_at: new Date().toISOString(),
      })
      .eq("id", offer.id)
      .eq("status", offer.status); // optimistic guard
    if (updErr) {
      console.error("[customer-counter-offer] update failed:", updErr);
      return errorResponse(updErr.message, 500, undefined, "COUNTER_WRITE_FAILED");
    }

    await logAuditEvent(svc, "customer_counter_offer_submitted", {
      userId,
      tripId: trip_id,
      details: { offer_id: offer.id, counter_fare_pence },
      ipAddress: clientIP,
      userAgent,
    });

    return successResponse({
      offer_id: offer.id,
      trip_id,
      counter_fare_pence,
      status: "customer_countered",
    });
  } catch (err) {
    console.error("[customer-counter-offer] error:", err);
    return errorResponse(
      err instanceof Error ? err.message : "Unknown error",
      500,
      undefined,
      "INTERNAL_ERROR",
    );
  }
});
