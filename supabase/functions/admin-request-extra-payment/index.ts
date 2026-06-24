import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import { STRIPE_STATEMENT_DESCRIPTOR } from "../_shared/stripeStatementDescriptor.ts";
import {
  assertExtraPaymentAmountTrusted,
  resolveExtraPaymentChargePence,
} from "../_shared/extraPaymentRecoverySSOT.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid(),
  amount_pence: z.number().int().positive().optional(),
  reason: z.string().trim().min(5, "Reason must be at least 5 characters").max(1000),
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.response;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }
    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: "Invalid input", details: parsed.error.flatten() }, 400);
    }
    const { trip_id, amount_pence, reason } = parsed.data;

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) return jsonResponse({ error: "STRIPE_SECRET_KEY not configured" }, 500);

    const { data: trip, error: tripErr } = await gate.supabase
      .from("trips")
      .select(
        "id, trip_number, passenger_id, driver_id, stripe_payment_intent_id, outstanding_balance_pence, "
        + "capture_amount_pence, final_fare_pence, tip_pence, tip_amount_pence, payment_status, "
        + "payment_coverage_status, currency_code, currency, arrival_cancellation_applied, arrival_cancellation_fee",
      )
      .eq("id", trip_id)
      .single();
    if (tripErr || !trip) return jsonResponse({ error: "Trip not found" }, 404);

    const { data: paymentRows, error: paymentsErr } = await gate.supabase
      .from("payments")
      .select("captured_amount_pence, amount_pence, status")
      .eq("trip_id", trip_id);
    if (paymentsErr) {
      return jsonResponse({ error: "Failed to load trip payments" }, 500);
    }

    const recovery = resolveExtraPaymentChargePence({
      trip,
      payments: paymentRows ?? [],
    });

    const amountMismatch = assertExtraPaymentAmountTrusted(amount_pence, recovery.charge_pence);
    if (amountMismatch) {
      return jsonResponse({ error: amountMismatch }, 400);
    }

    if (recovery.charge_pence <= 0) {
      return jsonResponse({
        error: "Trip has no outstanding balance to collect",
        settlement_total_pence: recovery.settlement_total_pence,
        captured_total_pence: recovery.captured_total_pence,
        outstanding_balance_pence: 0,
      }, 400);
    }

    const outstanding = recovery.charge_pence;
    const chargePence = outstanding;

    if (!trip.passenger_id) {
      return jsonResponse({ error: "Trip has no passenger — cannot charge extra payment" }, 400);
    }

    const { data: customer, error: customerErr } = await gate.supabase
      .from("customers")
      .select("id, user_id, stripe_customer_id")
      .eq("id", trip.passenger_id)
      .maybeSingle();
    if (customerErr || !customer) {
      return jsonResponse({ error: "Customer record not found for trip passenger" }, 404);
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });

    let stripeCustomerId = customer.stripe_customer_id as string | null;
    if (!stripeCustomerId) {
      return jsonResponse({
        error: "Customer has no Stripe customer — cannot charge off-session",
        requires_customer_action: true,
        outstanding_balance_pence: outstanding,
      }, 402);
    }

    const stripeCustomer = await stripe.customers.retrieve(stripeCustomerId);
    if (stripeCustomer.deleted) {
      return jsonResponse({ error: "Stripe customer was deleted" }, 400);
    }

    let paymentMethodId: string | null = null;
    const defaultPm = stripeCustomer.invoice_settings?.default_payment_method;
    if (typeof defaultPm === "string") {
      paymentMethodId = defaultPm;
    } else if (defaultPm && typeof defaultPm === "object" && "id" in defaultPm) {
      paymentMethodId = (defaultPm as { id: string }).id;
    }
    if (!paymentMethodId) {
      const listed = await stripe.paymentMethods.list({
        customer: stripeCustomerId,
        type: "card",
        limit: 1,
      });
      paymentMethodId = listed.data[0]?.id ?? null;
    }
    if (!paymentMethodId) {
      return jsonResponse({
        error: "No saved card on file — customer must add a payment method",
        requires_customer_action: true,
        outstanding_balance_pence: outstanding,
      }, 402);
    }

    const idempotencyKey = `admin_extra_payment_${trip_id}_${chargePence}`;
    console.log(`[admin-request-extra-payment] Statement descriptor SSOT: ${STRIPE_STATEMENT_DESCRIPTOR}`);
    let paymentIntent: Stripe.PaymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create(
        {
          amount: chargePence,
          currency: (trip.currency_code ?? trip.currency ?? "gbp").toLowerCase(),
          customer: stripeCustomerId,
          payment_method: paymentMethodId,
          off_session: true,
          confirm: true,
          metadata: {
            type: "trip_extra_payment",
            trip_id,
            trip_number: trip.trip_number ?? "",
            parent_payment_intent_id: trip.stripe_payment_intent_id ?? "",
            admin_reason: reason.slice(0, 500),
          },
        },
        { idempotencyKey },
      );
    } catch (stripeErr: unknown) {
      const err = stripeErr as {
        code?: string;
        decline_code?: string;
        message?: string;
        payment_intent?: Stripe.PaymentIntent;
      };
      const pi = err.payment_intent;
      if (err.code === "authentication_required" && pi?.client_secret) {
        return jsonResponse({
          error: "Customer authentication required to complete extra payment",
          requires_customer_action: true,
          client_secret: pi.client_secret,
          payment_intent_id: pi.id,
          outstanding_balance_pence: outstanding,
        }, 402);
      }
      return jsonResponse({
        error: err.message ?? "Stripe charge failed",
        code: err.code ?? null,
        decline_code: err.decline_code ?? null,
        requires_customer_action: err.code === "authentication_required",
        outstanding_balance_pence: outstanding,
      }, 402);
    }

    if (paymentIntent.status !== "succeeded") {
      return jsonResponse({
        error: `Extra payment incomplete (status: ${paymentIntent.status})`,
        payment_intent_id: paymentIntent.id,
        client_secret: paymentIntent.client_secret,
        requires_customer_action: paymentIntent.status === "requires_action",
        outstanding_balance_pence: outstanding,
      }, 402);
    }

    const chargeId = typeof paymentIntent.latest_charge === "string"
      ? paymentIntent.latest_charge
      : paymentIntent.latest_charge?.id ?? null;

    const priorCaptured = Math.max(0, Number(trip.capture_amount_pence ?? 0));
    const newCapturedTotal = priorCaptured + chargePence;
    const remainingOutstanding = Math.max(0, outstanding - chargePence);
    const fullyPaid = remainingOutstanding === 0;

    await gate.supabase.from("payments").insert({
      trip_id,
      stripe_payment_intent_id: paymentIntent.id,
      status: fullyPaid ? "captured" : "partially_paid",
      amount_pence: chargePence,
      captured_amount_pence: chargePence,
      currency: (trip.currency_code ?? trip.currency ?? "gbp").toLowerCase(),
      capture_method: "automatic",
      provider_charge_id: chargeId,
      metadata: {
        source: "admin_extra_payment",
        parent_payment_intent_id: trip.stripe_payment_intent_id,
        outstanding_before_pence: outstanding,
        outstanding_after_pence: remainingOutstanding,
        admin_reason: reason,
      },
    });

    await gate.supabase
      .from("trips")
      .update({
        outstanding_balance_pence: remainingOutstanding,
        capture_amount_pence: newCapturedTotal,
        payment_status: fullyPaid ? "captured" : "partially_paid",
        payment_coverage_status: fullyPaid ? "captured" : "under_captured",
        updated_at: new Date().toISOString(),
      })
      .eq("id", trip_id);

    await gate.supabase.from("admin_payment_audit").insert({
      trip_id,
      admin_user_id: gate.userId,
      action: "extra_payment",
      reason,
      amount_pence_before: priorCaptured,
      amount_pence_after: newCapturedTotal,
      delta_pence: chargePence,
      stripe_payment_intent_id: paymentIntent.id,
      metadata: {
        extra_payment_intent_id: paymentIntent.id,
        parent_payment_intent_id: trip.stripe_payment_intent_id,
        outstanding_before_pence: outstanding,
        outstanding_after_pence: remainingOutstanding,
        charge_id: chargeId,
        settlement_total_pence: recovery.settlement_total_pence,
        captured_total_pence: recovery.captured_total_pence,
        recovery_source: recovery.source,
        admin_user_id: gate.userId,
      },
    });

    return jsonResponse({
      success: true,
      message: fullyPaid
        ? `Extra payment of ${(chargePence / 100).toFixed(2)} collected — trip fully paid`
        : `Extra payment of ${(chargePence / 100).toFixed(2)} collected — ${(remainingOutstanding / 100).toFixed(2)} still due`,
      stripe_payment_intent_id: paymentIntent.id,
      stripe_charge_id: chargeId,
      charged_pence: chargePence,
      captured_total_pence: newCapturedTotal,
      outstanding_balance_pence: remainingOutstanding,
      settlement_total_pence: recovery.settlement_total_pence,
      captured_before_pence: recovery.captured_total_pence,
      recovery_source: recovery.source,
      admin_user_id: gate.userId,
      fully_paid: fullyPaid,
      reconciliation_cleared: fullyPaid && remainingOutstanding === 0,
    });
  } catch (e) {
    console.error("[admin-request-extra-payment] Error:", e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
