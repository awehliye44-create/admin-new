import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { calculateCommission } from "../_shared/commission.ts";
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
 * Uses Stripe Connect Destination Charges:
 *   - transfer_data.destination = driver's connected account
 *   - application_fee_amount = platform commission
 *
 * Supports: Card, Apple Pay, Google Pay (all via Stripe PaymentIntents API)
 *
 * The PaymentIntent is created with capture_method: 'manual' so the actual
 * capture happens in capture-trip-payment after the trip completes.
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
    const body = await req.json();
    const {
      trip_id,
      customer_id,
      estimated_fare_pence,
      currency_code = "gbp",
      payment_method_type = "card", // 'card' | 'apple_pay' | 'google_pay'
      stripe_payment_method_id, // pm_xxx from client-side (optional for Apple/Google Pay)
    } = body;

    if (!trip_id || !customer_id || !estimated_fare_pence) {
      return errorResponse("Missing required fields: trip_id, customer_id, estimated_fare_pence", 400);
    }

    if (estimated_fare_pence < 50) {
      return errorResponse("Minimum fare is 50 pence", 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");

    if (!stripeSecretKey) {
      return errorResponse("Stripe not configured", 500);
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });

    // === Get trip details ===
    const { data: trip, error: tripError } = await supabase
      .from("trips")
      .select("id, status, driver_id, service_area_id, currency, stripe_payment_intent_id")
      .eq("id", trip_id)
      .single();

    if (tripError || !trip) {
      return errorResponse("Trip not found", 404);
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

    // === Get customer's Stripe customer ID ===
    const { data: customer } = await supabase
      .from("customers")
      .select("id, stripe_customer_id, first_name, last_name, phone")
      .eq("id", customer_id)
      .single();

    if (!customer) {
      return errorResponse("Customer not found", 404);
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

    if (trip.driver_id) {
      const { data: driver } = await supabase
        .from("drivers")
        .select("stripe_account_id, category_id")
        .eq("id", trip.driver_id)
        .single();

      driverStripeAccountId = driver?.stripe_account_id || null;
      commissionPercentage = await getDriverCommissionPct(supabase, trip.driver_id);
    }

    const applicationFeeAmount = Math.round(estimated_fare_pence * commissionPercentage / 100);

    // === Determine payment method types ===
    // Card covers Apple Pay and Google Pay via Stripe's Payment Request Button
    const paymentMethodTypes: string[] = ["card"];

    // Apple Pay and Google Pay are handled as 'card' type in Stripe
    // but we can also explicitly add 'link' for Stripe Link wallets
    // The client-side Stripe SDK handles Apple/Google Pay detection automatically

    // === Create PaymentIntent with Destination Charges ===
    const piParams: Stripe.PaymentIntentCreateParams = {
      amount: estimated_fare_pence,
      currency: (currency_code || "gbp").toLowerCase(),
      customer: stripeCustomerId,
      capture_method: "manual", // Pre-authorize, capture after trip
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
      // Even without a connected account, store commission in metadata for capture-time enforcement
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

    console.log(`[create-payment-intent] Created PI: ${paymentIntent.id} for trip ${trip_id}`);
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
