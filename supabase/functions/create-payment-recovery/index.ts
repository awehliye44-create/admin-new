// create-payment-recovery
//
// Controlled payment recovery for a completed trip whose original booking
// payment session is orphaned (e.g. PAYMENT_GATE_BREACH_NO_CAPTURE, or a
// PENDING provider order that cannot be recaptured).
//
// Contract:
//   POST { trip_id, amount_pence?, parent_session_id? }
//   Response: { payment_session_id, provider_order_id, checkout_url, amount, currency }
//
// Guarantees:
//   - Preserves the original session verbatim (never mutates its state or order id).
//   - Creates a NEW Revolut Merchant order with capture_mode=automatic and a
//     recovery-scoped merchant_order_ext_ref (`recover:<trip_id>:<sessionUuid>`)
//     so the webhook can find and route it deterministically.
//   - Idempotent via a partial unique index: at most ONE open recovery attempt
//     (RECOVERY_CHECKOUT_CREATED / CUSTOMER_ACTION_REQUIRED) per trip. If an
//     open attempt already exists we return its checkout URL instead of
//     creating another Revolut order.
//   - Does NOT create a trip, dispatch, or ledger entry. Reconciliation runs
//     on the webhook side once Revolut confirms COMPLETED.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  errorResponse,
  successResponse,
  logAuditEvent,
} from "../_shared/security.ts";
import {
  createRevolutOrder,
  getRevolutMerchantConfig,
} from "../_shared/revolutOrders.ts";
import { resolveCurrencyFromTrip } from "../_shared/regionCurrency.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return errorResponse("method_not_allowed", 405, undefined, "METHOD_NOT_ALLOWED");
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // --- Admin auth ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return errorResponse("Missing authorization", 401, undefined, "AUTH_MISSING");
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return errorResponse("Unauthorized", 401, undefined, "AUTH_INVALID");
    const { data: adminRole } = await supabase
      .from("user_roles").select("role")
      .eq("user_id", user.id).eq("role", "admin").maybeSingle();
    if (!adminRole) return errorResponse("Admin access required", 403, undefined, "ADMIN_REQUIRED");

    const body = await req.json().catch(() => ({}));
    const { trip_id, amount_pence, parent_session_id } = body ?? {};
    if (!trip_id) return errorResponse("trip_id is required", 400, undefined, "VALIDATION_MISSING_FIELD");

    // --- Load trip ---
    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select("id, trip_number, status, passenger_id, service_area_id, driver_id, final_customer_fare_pence, capture_amount_pence, currency_code, payment_status")
      .eq("id", trip_id)
      .maybeSingle();
    if (tripErr || !trip) return errorResponse("Trip not found", 404, undefined, "TRIP_NOT_FOUND");
    if (trip.status !== "completed") {
      return errorResponse(
        `Recovery is only allowed for completed trips (status=${trip.status})`,
        409, undefined, "TRIP_NOT_COMPLETED",
      );
    }

    // --- Amount: prefer verified final customer fare, then capture amount, then explicit override ---
    const inferredAmount = Number(
      trip.final_customer_fare_pence ?? trip.capture_amount_pence ?? 0,
    );
    const chargePence = Math.round(Number(amount_pence ?? inferredAmount));
    if (!Number.isFinite(chargePence) || chargePence < 50) {
      return errorResponse(
        "Recovery amount must be >= 50 minor units. Provide amount_pence or set final_customer_fare_pence on the trip.",
        400, undefined, "VALIDATION_FAILED",
      );
    }

    // --- Currency from region SSOT ---
    let currency: string;
    try {
      const r = await resolveCurrencyFromTrip(supabase, trip.id);
      currency = r.currency_code.toLowerCase();
    } catch (e) {
      return errorResponse((e as Error).message, 400, undefined, "REGION_CURRENCY_UNRESOLVABLE");
    }

    // --- Short-circuit: if an open recovery already exists, return its URL ---
    const { data: existingOpen } = await supabase
      .from("payment_sessions")
      .select("id, provider_order_id, provider_checkout_url, status, captured_amount_pence, authorised_amount_pence")
      .eq("trip_id", trip.id)
      .eq("purpose", "PAYMENT_RECOVERY")
      .in("status", ["RECOVERY_CHECKOUT_CREATED", "CUSTOMER_ACTION_REQUIRED"])
      .maybeSingle();
    if (existingOpen) {
      return successResponse({
        payment_session_id: existingOpen.id,
        provider_order_id: existingOpen.provider_order_id,
        checkout_url: existingOpen.provider_checkout_url,
        amount: chargePence,
        currency,
        reused: true,
      });
    }

    // --- Also block if a prior recovery already completed for this trip ---
    const { data: existingCompleted } = await supabase
      .from("payment_sessions")
      .select("id")
      .eq("trip_id", trip.id)
      .eq("purpose", "PAYMENT_RECOVERY")
      .eq("status", "RECOVERY_COMPLETED")
      .maybeSingle();
    if (existingCompleted) {
      return errorResponse(
        "This trip already has a completed recovery payment. Duplicate recovery blocked.",
        409, undefined, "RECOVERY_ALREADY_COMPLETED",
      );
    }

    // --- Insert placeholder session first (reserves the "open recovery" slot) ---
    const { data: session, error: sessInsertErr } = await supabase
      .from("payment_sessions")
      .insert({
        trip_id: trip.id,
        customer_id: trip.passenger_id,
        service_area_id: trip.service_area_id,
        provider: "revolut",
        purpose: "PAYMENT_RECOVERY",
        status: "RECOVERY_CHECKOUT_CREATED",
        authorised_amount_pence: chargePence,
        currency_code: currency.toUpperCase(),
        parent_session_id: parent_session_id ?? null,
        recovery_reason: "PAYMENT_GATE_BREACH_NO_CAPTURE",
      })
      .select("id")
      .single();
    if (sessInsertErr || !session) {
      // Unique-index violation is the expected concurrent-attempt guard.
      return errorResponse(
        `Could not open a recovery session: ${sessInsertErr?.message ?? "insert failed"}`,
        409, undefined, "RECOVERY_LOCK_FAILED",
      );
    }

    // --- Create Revolut order (automatic capture — no separate capture step) ---
    let order;
    try {
      const { secretKey, environment } = getRevolutMerchantConfig();
      order = await createRevolutOrder({
        environment,
        secretKey,
        amountMinor: chargePence,
        currency,
        tripId: trip.id,
        captureMode: "automatic",
        merchantOrderExtRef: `recover:${trip.id}:${session.id}`,
        description: `ONECAB payment recovery — trip ${trip.trip_number ?? trip.id}`,
        metadata: {
          trip_id: trip.id,
          trip_number: trip.trip_number ?? "",
          purpose: "PAYMENT_RECOVERY",
          recovery_session_id: session.id,
          parent_session_id: parent_session_id ?? "",
        },
      });
    } catch (e) {
      // Roll back the reserved session so admins can retry cleanly.
      await supabase.from("payment_sessions")
        .update({ status: "RECOVERY_CANCELLED", updated_at: new Date().toISOString() })
        .eq("id", session.id);
      return errorResponse(
        `Revolut order creation failed: ${(e as Error).message}`,
        502, undefined, "PROVIDER_ORDER_CREATE_FAILED",
      );
    }

    // --- Persist provider identifiers + checkout URL onto the session ---
    await supabase
      .from("payment_sessions")
      .update({
        provider_order_id: order.id,
        provider_checkout_url: order.checkout_url ?? null,
        status: "CUSTOMER_ACTION_REQUIRED",
        updated_at: new Date().toISOString(),
      })
      .eq("id", session.id);

    await logAuditEvent(supabase, "payment_recovery_created", {
      tripId: trip.id,
      details: {
        recovery_session_id: session.id,
        parent_session_id: parent_session_id ?? null,
        provider: "revolut",
        provider_order_id: order.id,
        amount_pence: chargePence,
        currency,
      },
    });

    return successResponse({
      payment_session_id: session.id,
      provider_order_id: order.id,
      checkout_url: order.checkout_url,
      checkout_token: order.token,
      amount: chargePence,
      currency,
      status: "CUSTOMER_ACTION_REQUIRED",
    });
  } catch (e) {
    console.error("[create-payment-recovery] error:", e);
    return errorResponse((e as Error).message ?? "unknown_error", 500);
  }
});
