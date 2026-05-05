import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { calculateCommission } from "../_shared/commission.ts";
import { resolveCurrencyFromTrip, resolveCurrencyFromServiceArea } from "../_shared/regionCurrency.ts";
import { computePreauthHold, type PreauthBufferConfig } from "../_shared/preauthBuffer.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import {
  corsHeaders,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  successResponse,
  errorResponse,
  logAuditEvent,
} from "../_shared/security.ts";

const RATE_LIMIT_CONFIG = { limit: 20, windowMs: 60 * 1000 };

/**
 * create-payment-intent
 *
 * Called by the customer app BEFORE the trip starts to pre-authorize payment.
 * Currency is resolved from Region (single source of truth).
 */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult.retryAfter!);
  }

  try {
    // === Authenticate caller via JWT ===
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse("Missing authorization header", 401, undefined, "AUTH_MISSING");
    }

    const supabaseUrlForAuth = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKeyForAuth = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authClient = createClient(supabaseUrlForAuth, supabaseServiceKeyForAuth);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user: authUser }, error: authError } = await authClient.auth.getUser(token);

    if (authError || !authUser) {
      return errorResponse("Unauthorized", 401, undefined, "AUTH_INVALID");
    }

    const body = await req.json();
    const {
      trip_id,
      customer_id,
      estimated_fare_pence,
      discount_amount_pence = 0,
      payment_method_type = "card",
      stripe_payment_method_id,
    } = body;

    if (!trip_id || !customer_id || !estimated_fare_pence) {
      return errorResponse("Missing required fields: trip_id, customer_id, estimated_fare_pence", 400, undefined, "VALIDATION_MISSING_FIELD");
    }

    if (estimated_fare_pence < 50) {
      return errorResponse("Minimum fare is 50 pence", 400, undefined, "VALIDATION_FAILED");
    }

    // Payable amount = what we will MAX capture (estimated fare minus discount).
    // This is the upper bound for `application_fee_amount` and the base for the buffer.
    const safeDiscount = Math.max(0, Math.min(Math.round(discount_amount_pence), estimated_fare_pence));
    const payable_pence = Math.max(0, estimated_fare_pence - safeDiscount);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");

    if (!stripeSecretKey) {
      return errorResponse("Stripe not configured", 500, undefined, "PAYMENT_STRIPE_ERROR");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });
    let platformStripeAccountId: string | null = null;
    try {
      const platformAccount = await stripe.accounts.retrieve();
      platformStripeAccountId = platformAccount.id;
    } catch (accountError) {
      console.warn('[create-payment-intent] Could not resolve platform Stripe account:', accountError);
    }

    // === Resolve currency from Region (single source of truth) ===
    let currency_code: string;
    try {
      const regionCurrency = await resolveCurrencyFromTrip(supabase, trip_id);
      currency_code = regionCurrency.currency_code.toLowerCase();
    } catch (e) {
      console.error('[create-payment-intent] Currency resolution failed:', e);
      return errorResponse((e as Error).message, 400, undefined, "REGION_CURRENCY_UNRESOLVABLE");
    }

    // === Get trip details ===
    const { data: trip, error: tripError } = await supabase
      .from("trips")
      .select("id, status, driver_id, service_area_id, stripe_payment_intent_id")
      .eq("id", trip_id)
      .single();

    if (tripError || !trip) {
      return errorResponse("Trip not found", 404, undefined, "TRIP_NOT_FOUND");
    }

    // Idempotency: if PI already exists, return it
    if (trip.stripe_payment_intent_id) {
      try {
        const existingPI = await stripe.paymentIntents.retrieve(trip.stripe_payment_intent_id);
        if (existingPI && ["requires_payment_method", "requires_confirmation", "requires_capture"].includes(existingPI.status)) {
          return successResponse({
            payment_intent_id: existingPI.id,
            client_secret: existingPI.client_secret,
            status: existingPI.status,
            idempotent: true,
          });
        }
      } catch {
        // PI invalid, create new one
      }
    }

    // === Get customer and verify rider_status ===
    const { data: customer } = await supabase
      .from("customers")
      .select("id, stripe_customer_id, first_name, last_name, phone, rider_status")
      .eq("id", customer_id)
      .single();

    if (!customer) {
      return errorResponse("Customer not found", 404, undefined, "VALIDATION_FAILED");
    }

    const riderStatus = (customer as any).rider_status || "active";
    if (riderStatus !== "active") {
      console.warn(`[create-payment-intent] Blocked: rider_status=${riderStatus} for customer ${customer_id}`);
      return errorResponse(
        `Booking blocked: rider account is ${riderStatus}`,
        403,
        undefined,
        "RIDER_STATUS_BLOCKED"
      );
    }

    // Create Stripe Customer if doesn't exist
    let stripeCustomerId = customer.stripe_customer_id;
    if (!stripeCustomerId) {
      const stripeCustomer = await stripe.customers.create({
        metadata: { onecab_customer_id: customer_id },
        name: [customer.first_name, customer.last_name].filter(Boolean).join(" ") || undefined,
        phone: customer.phone || undefined,
      });
      stripeCustomerId = stripeCustomer.id;

      await supabase
        .from("customers")
        .update({ stripe_customer_id: stripeCustomerId })
        .eq("id", customer_id);
    }

    // === Get driver's connected account ===
    // IMPORTANT: commission is calculated on the PAYABLE amount (estimated fare − discount).
    // The pre-auth buffer is NEVER part of commission or driver earnings.
    let driverStripeAccountId: string | null = null;
    let commissionPercentage = 0;
    let applicationFeeAmount = 0;

    if (trip.driver_id) {
      const { data: driver } = await supabase
        .from("drivers")
        .select("stripe_account_id, category_id")
        .eq("id", trip.driver_id)
        .single();

      driverStripeAccountId = driver?.stripe_account_id || null;
      const result = await calculateCommission(supabase, trip.driver_id, payable_pence);
      commissionPercentage = result.commission_pct;
      applicationFeeAmount = result.commission_pence;
    }

    // === Resolve pre-auth buffer for this service area ===
    // Pure payment-layer setting. NEVER touches fare math or driver earnings.
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

    // Defensive: Stripe minimum charge ~50p
    if (hold_pence < 50) {
      return errorResponse("Hold amount below minimum", 400, undefined, "VALIDATION_FAILED");
    }

    // === Determine payment method types ===
    const paymentMethodTypes: string[] = ["card"];

    // === Create PaymentIntent with Destination Charges ===
    // amount = HOLD (payable + buffer). application_fee_amount = commission on PAYABLE.
    // Stripe will release any uncaptured remainder back to the customer.
    const piParams: Stripe.PaymentIntentCreateParams = {
      amount: hold_pence,
      currency: currency_code,
      customer: stripeCustomerId,
      capture_method: "manual",
      payment_method_types: paymentMethodTypes,
      metadata: {
        trip_id,
        customer_id,
        payment_method_type,
        platform_stripe_account_id: platformStripeAccountId ?? 'unknown',
        commission_pct: String(commissionPercentage),
        estimated_fare_pence: String(estimated_fare_pence),
        discount_amount_pence: String(safeDiscount),
        payable_pence: String(payable_pence),
        preauth_buffer_pence: String(buffer_pence),
        preauth_hold_pence: String(hold_pence),
      },
    };

    // Add Destination Charges if driver has a connected account
    if (driverStripeAccountId) {
      piParams.transfer_data = {
        destination: driverStripeAccountId,
      };
      piParams.application_fee_amount = applicationFeeAmount;
      piParams.metadata = {
        ...piParams.metadata,
        application_fee_amount_pence: String(applicationFeeAmount),
        stripe_destination_account_id: driverStripeAccountId,
        connect_flow: 'destination_charge',
      };
    } else {
      console.warn(`[create-payment-intent] Driver has no Stripe connected account for trip ${trip_id}. Commission will be enforced at capture time.`);
      piParams.metadata = {
        ...piParams.metadata,
        application_fee_amount_pence: String(applicationFeeAmount),
        no_connected_account: "true",
        connect_flow: 'platform_charge_manual_payout',
      };
    }

    // Attach payment method if provided (for saved cards)
    if (stripe_payment_method_id) {
      piParams.payment_method = stripe_payment_method_id;
    }

    const paymentIntent = await stripe.paymentIntents.create(piParams, {
      idempotencyKey: `create_pi_${trip_id}`,
    });

    console.log(`[create-payment-intent] Created PI: ${paymentIntent.id} for trip ${trip_id}, currency: ${currency_code}, platform_account=${platformStripeAccountId ?? 'unknown'}`);
    console.log(`[stripe-settlement-create] payment_intent_id=${paymentIntent.id} trip=${trip_id} charge_type=${driverStripeAccountId ? 'destination_charge' : 'platform_charge_manual_payout'} final_fare_pence=${payable_pence} commission_pence=${applicationFeeAmount} driver_transfer_amount=${Math.max(0, payable_pence - applicationFeeAmount)} application_fee_amount=${driverStripeAccountId ? applicationFeeAmount : 'none'} connected_account_id=${driverStripeAccountId || "none"} platform_account_id=${platformStripeAccountId ?? 'unknown'} preauth_hold_pence=${hold_pence} preauth_buffer_pence=${buffer_pence}`);

    // Store PI + informational hold/buffer columns on the trip.
    // authorised_amount_pence = the actual Stripe hold (informational).
    // preauth_buffer_pence    = how much of that hold is buffer (informational).
    // Neither column feeds into fare/commission/ledger math.
    await supabase
      .from("trips")
      .update({
        stripe_payment_intent_id: paymentIntent.id,
        stripe_application_fee_amount_pence: applicationFeeAmount,
        stripe_destination_account_id: driverStripeAccountId,
        stripe_settlement_verified: false,
        stripe_settlement_warning: driverStripeAccountId ? null : 'NO_DRIVER_CONNECT_ACCOUNT_PLATFORM_CHARGE_ONLY_UNTIL_MANUAL_PAYOUT',
        payment_method: payment_method_type === "apple_pay" ? "APPLE_PAY" : payment_method_type === "google_pay" ? "GOOGLE_PAY" : "CARD",
        payment_status: "authorized",
        authorised_amount_pence: hold_pence,
        preauth_buffer_pence: buffer_pence,
        updated_at: new Date().toISOString(),
      })
      .eq("id", trip_id);

    await logAuditEvent(supabase, "payment_intent_created", {
      tripId: trip_id,
      details: {
        payment_intent_id: paymentIntent.id,
        estimated_fare_pence,
        discount_amount_pence: safeDiscount,
        payable_pence,
        preauth_buffer_pence: buffer_pence,
        preauth_hold_pence: hold_pence,
        application_fee: applicationFeeAmount,
        payment_method_type,
        driver_account: driverStripeAccountId,
        currency: currency_code,
      },
      ipAddress: clientIP,
      userAgent: req.headers.get("user-agent") || "unknown",
    });

    return successResponse({
      payment_intent_id: paymentIntent.id,
      client_secret: paymentIntent.client_secret,
      status: paymentIntent.status,
      // Spec API contract — explicit and unambiguous:
      estimated_fare_pence,
      discount_amount_pence: safeDiscount,
      payable_pence,                    // max we will capture
      preauth_buffer_pence: buffer_pence,
      preauth_hold_pence: hold_pence,   // what Stripe holds on the card
      // Legacy alias kept for client compatibility:
      amount: hold_pence,
      currency: currency_code,
      application_fee_amount: applicationFeeAmount,
      stripe_customer_id: stripeCustomerId,
    });

  } catch (error) {
    console.error("[create-payment-intent] Error:", error);
    return errorResponse(
      error instanceof Error ? error.message : "Unknown error",
      500
    );
  }
});
