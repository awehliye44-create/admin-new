import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import { applyStripeRefundToOnecab } from "../_shared/applyStripeRefund.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid().optional(),
  trip_code: z.string().trim().min(1).optional(),
  payment_intent_id: z.string().trim().min(1).optional(),
}).refine(
  (v) => Boolean(v.trip_id || v.trip_code || v.payment_intent_id),
  { message: "Provide trip_id, trip_code, or payment_intent_id" },
);

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

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) return jsonResponse({ error: "STRIPE_SECRET_KEY not configured" }, 500);

    const { trip_id, trip_code, payment_intent_id } = parsed.data;

    let tripQuery = gate.supabase
      .from("trips")
      .select(`
        id, trip_code, stripe_payment_intent_id, stripe_charge_id,
        capture_amount_pence, refund_amount_pence, payment_status, payment_method,
        stripe_transfer_id, stripe_transfer_amount_pence, stripe_destination_account_id,
        stripe_application_fee_id, stripe_application_fee_amount_pence
      `);
    if (trip_id) tripQuery = tripQuery.eq("id", trip_id);
    else if (trip_code) tripQuery = tripQuery.eq("trip_code", trip_code);
    else if (payment_intent_id) tripQuery = tripQuery.eq("stripe_payment_intent_id", payment_intent_id);

    const { data: trip, error: tripErr } = await tripQuery.maybeSingle();
    if (tripErr || !trip) return jsonResponse({ error: "Trip not found" }, 404);

    const piId = trip.stripe_payment_intent_id ?? payment_intent_id;
    if (!piId) return jsonResponse({ error: "Trip has no Stripe PaymentIntent" }, 400);

    const beforeSnapshot = {
      payment_status: trip.payment_status,
      capture_amount_pence: trip.capture_amount_pence ?? 0,
      refund_amount_pence: trip.refund_amount_pence ?? 0,
      stripe_charge_id: trip.stripe_charge_id,
      stripe_transfer_id: trip.stripe_transfer_id,
    };

    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });
    const pi = await stripe.paymentIntents.retrieve(String(piId), {
      expand: [
        "latest_charge",
        "latest_charge.balance_transaction",
        "latest_charge.application_fee",
        "latest_charge.transfer",
      ],
    });

    const charge = pi.latest_charge && typeof pi.latest_charge === "object"
      ? pi.latest_charge as Stripe.Charge
      : null;

    let captureSynced = false;
    let refundSynced = false;
    let stripeFieldsUpdated = false;

    const tripUpdates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (charge) {
      tripUpdates.stripe_charge_id = charge.id;
      stripeFieldsUpdated = trip.stripe_charge_id !== charge.id;

      const transfer = (charge as unknown as { transfer?: string | { id: string; amount?: number } }).transfer;
      if (transfer) {
        const transferId = typeof transfer === "string" ? transfer : transfer.id;
        const transferAmount = typeof transfer === "object" ? transfer.amount ?? null : null;
        tripUpdates.stripe_transfer_id = transferId;
        if (transferAmount != null) tripUpdates.stripe_transfer_amount_pence = transferAmount;
        stripeFieldsUpdated = true;
      }

      if (charge.application_fee) {
        tripUpdates.stripe_application_fee_id =
          typeof charge.application_fee === "string" ? charge.application_fee : charge.application_fee.id;
        if (typeof charge.application_fee === "object") {
          tripUpdates.stripe_application_fee_amount_pence = charge.application_fee.amount ?? null;
        }
        stripeFieldsUpdated = true;
      }

      const piDestination = pi.transfer_data?.destination;
      if (piDestination) {
        tripUpdates.stripe_destination_account_id =
          typeof piDestination === "string" ? piDestination : piDestination.id;
        stripeFieldsUpdated = true;
      }

      const stripeCaptured = charge.amount_captured ?? 0;
      const onecabCaptured = trip.capture_amount_pence ?? 0;

      // Sync existing Stripe capture state only — never call capture API from this function.
      if (stripeCaptured > 0 && stripeCaptured !== onecabCaptured) {
        tripUpdates.capture_amount_pence = stripeCaptured;
        tripUpdates.payment_status = pi.status === "succeeded" ? "captured" : trip.payment_status;
        captureSynced = true;
      } else if (pi.status === "requires_capture" && onecabCaptured === 0) {
        tripUpdates.payment_status = "authorized";
      }
    }

    if (Object.keys(tripUpdates).length > 1) {
      await gate.supabase.from("trips").update(tripUpdates).eq("id", trip.id);
    }

    if (charge && (charge.amount_refunded ?? 0) > 0) {
      const amountRefunded = charge.amount_refunded ?? 0;
      const onecabRefunded = trip.refund_amount_pence ?? 0;
      if (amountRefunded > onecabRefunded) {
        const refunds = await stripe.refunds.list({ charge: charge.id, limit: 10 });
        const latestRefund = refunds.data[0] ?? null;
        await applyStripeRefundToOnecab(gate.supabase, {
          tripId: String(trip.id),
          amountRefundedPence: amountRefunded,
          stripeRefundId: latestRefund?.id ?? null,
          stripeChargeId: charge.id,
          stripePaymentIntentId: pi.id,
          source: "admin_sync",
          refundReason: latestRefund?.reason ?? "sync_from_stripe",
        });
        refundSynced = true;
      }
    }

    const afterSnapshot = {
      stripe_status: pi.status,
      capture_amount_pence: tripUpdates.capture_amount_pence ?? trip.capture_amount_pence ?? 0,
      refund_amount_pence: charge?.amount_refunded ?? trip.refund_amount_pence ?? 0,
      stripe_charge_id: charge?.id ?? trip.stripe_charge_id,
    };

    await gate.supabase.from("admin_payment_audit").insert({
      trip_id: trip.id,
      admin_user_id: gate.userId,
      action: "sync_stripe",
      reason: "Sync payment state from Stripe Dashboard / live Stripe API",
      amount_pence_before: beforeSnapshot.capture_amount_pence,
      amount_pence_after: Number(afterSnapshot.capture_amount_pence ?? 0),
      delta_pence: Number(afterSnapshot.capture_amount_pence ?? 0) - beforeSnapshot.capture_amount_pence,
      stripe_payment_intent_id: pi.id,
      metadata: {
        before: beforeSnapshot,
        after: afterSnapshot,
        capture_synced: captureSynced,
        refund_synced: refundSynced,
        stripe_fields_updated: stripeFieldsUpdated,
      },
    });

    if (!captureSynced && !refundSynced && !stripeFieldsUpdated) {
      return jsonResponse({
        success: true,
        message: "Stripe state already matches ONECAB — no changes applied",
        capture_synced: false,
        refund_synced: false,
        stripe_fields_updated: false,
        stripe_status: pi.status,
      });
    }

    return jsonResponse({
      success: true,
      message: "Payment state synced from Stripe",
      capture_synced: captureSynced,
      refund_synced: refundSynced,
      stripe_fields_updated: stripeFieldsUpdated,
      stripe_status: pi.status,
      stripe_payment_intent_id: pi.id,
      stripe_charge_id: charge?.id ?? null,
    });
  } catch (e) {
    console.error("[admin-sync-trip-payment-from-stripe]", e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
