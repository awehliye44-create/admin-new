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
      payment_method_type = "card",
      stripe_payment_method_id,
    } = body;

    if (!trip_id || !customer_id || !estimated_fare_pence) {
      return errorResponse("Missing required fields: trip_id, customer_id, estimated_fare_pence", 400, undefined, "VALIDATION_MISSING_FIELD");
    }

    if (estimated_fare_pence < 50) {
      return errorResponse("Minimum fare is 50 pence", 400, undefined, "VALIDATION_FAILED");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");

    if (!stripeSecretKey) {
      return errorResponse("Stripe not configured", 500, undefined, "PAYMENT_STRIPE_ERROR");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });

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
      const result = await calculateCommission(supabase, trip.driver_id, estimated_fare_pence);
      commissionPercentage = result.commission_pct;
      applicationFeeAmount = result.commission_pence;
    }

    // === Determine payment method types ===
    const paymentMethodTypes: string[] = ["card"];

    // === Create PaymentIntent with Destination Charges ===
    const piParams: Stripe.PaymentIntentCreateParams = {
      amount: estimated_fare_pence,
      currency: currency_code,
      customer: stripeCustomerId,
      capture_method: "manual",
      payment_method_types: paymentMethodTypes,
      metadata: {
        trip_id,
        customer_id,
        payment_method_type,
        commission_pct: String(commissionPercentage),
      },
    };

    // Add Destination Charges if driver has a connected account
    if (driverStripeAccountId) {
      piParams.transfer_data = {
        destination: driverStripeAccountId,
      };
      piParams.application_fee_amount = applicationFeeAmount;
    } else {
      console.warn(`[create-payment-intent] Driver has no Stripe connected account for trip ${trip_id}. Commission will be enforced at capture time.`);
      piParams.metadata = {
        ...piParams.metadata,
        application_fee_amount_pence: String(applicationFeeAmount),
        no_connected_account: "true",
      };
    }

    // Attach payment method if provided (for saved cards)
    if (stripe_payment_method_id) {
      piParams.payment_method = stripe_payment_method_id;
    }

    const paymentIntent = await stripe.paymentIntents.create(piParams, {
      idempotencyKey: `create_pi_${trip_id}`,
    });

    console.log(`[create-payment-intent] Created PI: ${paymentIntent.id} for trip ${trip_id}, currency: ${currency_code}`);
    console.log(`[create-payment-intent] Amount: ${estimated_fare_pence}p, AppFee: ${applicationFeeAmount}p, Destination: ${driverStripeAccountId || "none"}`);

    // Store PI on the trip
    await supabase
      .from("trips")
      .update({
        stripe_payment_intent_id: paymentIntent.id,
        payment_method: payment_method_type === "apple_pay" ? "APPLE_PAY" : payment_method_type === "google_pay" ? "GOOGLE_PAY" : "CARD",
        payment_status: "authorized",
        updated_at: new Date().toISOString(),
      })
      .eq("id", trip_id);

    await logAuditEvent(supabase, "payment_intent_created", {
      tripId: trip_id,
      details: {
        payment_intent_id: paymentIntent.id,
        amount: estimated_fare_pence,
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
      amount: estimated_fare_pence,
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
