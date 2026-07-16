import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { calculateCommission } from "../_shared/commission.ts";
import { resolveCurrencyFromTrip } from "../_shared/regionCurrency.ts";
import { computePreauthHold, type PreauthBufferConfig } from "../_shared/preauthBuffer.ts";
import {
  corsHeaders,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  successResponse,
  errorResponse,
  logAuditEvent,
} from "../_shared/security.ts";
import {
  createRevolutOrder,
  getRevolutMerchantConfig,
  retrieveRevolutOrder,
} from "../_shared/revolutOrders.ts";

const RATE_LIMIT_CONFIG = { limit: 20, windowMs: 60 * 1000 };

/**
 * create-payment-intent (Revolut Merchant Orders)
 *
 * Phase 2 rewrite. Called by the customer app BEFORE the trip starts to
 * pre-authorise payment. Creates a Revolut order with capture_mode=manual.
 *
 * Response contract (backwards-compatible fields kept as aliases):
 *   payment_intent_id  → provider order id  (was Stripe PI id)
 *   client_secret      → provider checkout token (was Stripe PI client_secret)
 *   amount             → hold amount in minor units
 *   currency           → lower-case ISO code
 *   plus explicit: provider, provider_order_id, provider_checkout_token,
 *   provider_checkout_url, payable_pence, preauth_hold_pence,
 *   preauth_buffer_pence, application_fee_amount (commission for internal use).
 */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) return rateLimitResponse(rateLimitResult.retryAfter!);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse("Missing authorization header", 401, undefined, "AUTH_MISSING");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authUser) {
      return errorResponse("Unauthorized", 401, undefined, "AUTH_INVALID");
    }

    const body = await req.json();
    const {
      trip_id,
      estimated_fare_pence,
      discount_amount_pence = 0,
      payment_method_type = "card",
    } = body ?? {};

    if (!trip_id || !estimated_fare_pence) {
      return errorResponse(
        "Missing required fields: trip_id, estimated_fare_pence",
        400, undefined, "VALIDATION_MISSING_FIELD",
      );
    }
    if (estimated_fare_pence < 50) {
      return errorResponse("Minimum fare is 50 pence", 400, undefined, "VALIDATION_FAILED");
    }

    const safeDiscount = Math.max(0, Math.min(Math.round(discount_amount_pence), estimated_fare_pence));
    const payable_pence = Math.max(0, estimated_fare_pence - safeDiscount);

    // === Region currency SSOT ===
    let currency_code: string;
    try {
      const regionCurrency = await resolveCurrencyFromTrip(supabase, trip_id);
      currency_code = regionCurrency.currency_code.toLowerCase();
    } catch (e) {
      return errorResponse((e as Error).message, 400, undefined, "REGION_CURRENCY_UNRESOLVABLE");
    }

    // === Verify caller owns the trip ===
    const { data: callerCustomer, error: callerCustomerError } = await supabase
      .from("customers")
      .select("id, first_name, last_name, phone, rider_status")
      .eq("user_id", authUser.id)
      .maybeSingle();
    if (callerCustomerError || !callerCustomer) {
      return errorResponse("Customer profile not found for authenticated user", 403, undefined, "AUTH_INVALID");
    }
    const customer_id = callerCustomer.id;

    const { data: trip, error: tripError } = await supabase
      .from("trips")
      .select("id, status, driver_id, service_area_id, passenger_id, payment_provider, provider_order_id")
      .eq("id", trip_id)
      .single();
    if (tripError || !trip) {
      return errorResponse("Trip not found", 404, undefined, "TRIP_NOT_FOUND");
    }
    if (trip.passenger_id !== customer_id) {
      return errorResponse("Forbidden: trip does not belong to caller", 403, undefined, "AUTH_INVALID");
    }

    const riderStatus = (callerCustomer as { rider_status?: string }).rider_status || "active";
    if (riderStatus !== "active") {
      return errorResponse(
        `Booking blocked: rider account is ${riderStatus}`,
        403, undefined, "RIDER_STATUS_BLOCKED",
      );
    }

    // === Resolve Revolut credentials ===
    const { secretKey, environment } = getRevolutMerchantConfig();

    // === Idempotency: reuse an active Revolut order if one already exists ===
    if (trip.payment_provider === "revolut" && trip.provider_order_id) {
      try {
        const existing = await retrieveRevolutOrder(environment, secretKey, trip.provider_order_id);
        const reusable = ["PENDING", "PROCESSING", "AUTHORISED"].includes(String(existing.state ?? "").toUpperCase());
        if (reusable) {
          return successResponse({
            provider: "revolut",
            provider_order_id: existing.id,
            provider_checkout_token: existing.token,
            provider_checkout_url: existing.checkout_url,
            payment_intent_id: existing.id,
            client_secret: existing.token,
            status: existing.state,
            idempotent: true,
            amount: existing.amount,
            currency: (existing.currency ?? currency_code).toLowerCase(),
          });
        }
      } catch {
        // Fall through and create a new order.
      }
    }

    // === Commission (informational only in Phase 2; applied at capture / payout time) ===
    let commissionPercentage = 0;
    let commissionPence = 0;
    if (trip.driver_id) {
      const result = await calculateCommission(supabase, trip.driver_id, payable_pence, trip.service_area_id);
      commissionPercentage = result.commission_pct;
      commissionPence = result.commission_pence;
    }

    // === Pre-auth buffer (payment-layer setting; never touches fare math) ===
    let preauthCfg: PreauthBufferConfig | null = null;
    if (trip.service_area_id) {
      const { data: cfgRow } = await supabase
        .from("service_area_preauth_settings")
        .select("enable_preauth_buffer, buffer_type, buffer_value, min_hold_pence, max_hold_pence")
        .eq("service_area_id", trip.service_area_id)
        .maybeSingle();
      if (cfgRow) preauthCfg = cfgRow as PreauthBufferConfig;
    }
    const holdResult = computePreauthHold(payable_pence, preauthCfg);
    const hold_pence = holdResult.hold_pence;
    const buffer_pence = holdResult.buffer_pence;

    if (hold_pence < 50) {
      return errorResponse("Hold amount below minimum", 400, undefined, "VALIDATION_FAILED");
    }

    // === Create Revolut order (manual capture) ===
    const order = await createRevolutOrder({
      environment,
      secretKey,
      amountMinor: hold_pence,
      currency: currency_code,
      tripId: trip_id,
      description: `ONECAB trip ${trip_id}`,
      metadata: {
        trip_id,
        customer_id,
        payment_method_type: String(payment_method_type),
        commission_pct: String(commissionPercentage),
        estimated_fare_pence: String(estimated_fare_pence),
        discount_amount_pence: String(safeDiscount),
        payable_pence: String(payable_pence),
        preauth_buffer_pence: String(buffer_pence),
        preauth_hold_pence: String(hold_pence),
      },
    });

    // === Persist provider fields onto the trip ===
    // P0 GATE FIX: do NOT set payment_status='authorized' here. Order is PENDING
    // until Revolut emits ORDER_AUTHORISED via revolut-webhook, which is the
    // sole authoritative source for authorised_amount_pence and payment_status.
    await supabase
      .from("trips")
      .update({
        payment_provider: "revolut",
        provider_order_id: order.id,
        provider_checkout_token: order.token ?? null,
        payment_method:
          payment_method_type === "apple_pay" ? "APPLE_PAY" :
          payment_method_type === "google_pay" ? "GOOGLE_PAY" : "CARD",
        payment_status: "pending",
        preauth_buffer_pence: buffer_pence,
        updated_at: new Date().toISOString(),
      })
      .eq("id", trip_id);

    await logAuditEvent(supabase, "payment_intent_created", {
      tripId: trip_id,
      details: {
        provider: "revolut",
        provider_order_id: order.id,
        environment,
        estimated_fare_pence,
        discount_amount_pence: safeDiscount,
        payable_pence,
        preauth_buffer_pence: buffer_pence,
        preauth_hold_pence: hold_pence,
        commission_pct: commissionPercentage,
        expected_commission_pence: commissionPence,
        payment_method_type,
        currency: currency_code,
      },
      ipAddress: clientIP,
      userAgent: req.headers.get("user-agent") || "unknown",
    });

    console.log(`[create-payment-intent] revolut order=${order.id} trip=${trip_id} hold=${hold_pence} ${currency_code} env=${environment}`);

    return successResponse({
      provider: "revolut",
      provider_order_id: order.id,
      provider_checkout_token: order.token,
      provider_checkout_url: order.checkout_url,
      // Backwards-compatible aliases for existing customer app callers:
      payment_intent_id: order.id,
      client_secret: order.token,
      status: order.state ?? "PENDING",
      estimated_fare_pence,
      discount_amount_pence: safeDiscount,
      payable_pence,
      preauth_buffer_pence: buffer_pence,
      preauth_hold_pence: hold_pence,
      amount: hold_pence,
      currency: currency_code,
      application_fee_amount: commissionPence,
    });
  } catch (error) {
    console.error("[create-payment-intent] Error:", error);
    return errorResponse(
      error instanceof Error ? error.message : "Unknown error",
      500,
    );
  }
});
