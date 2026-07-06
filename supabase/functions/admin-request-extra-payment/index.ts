// Admin: request an extra payment from a customer to cover a trip's outstanding balance.
// Creates a fresh Revolut order (auto-capture) and returns a checkout token/URL for the customer app.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import {
  createRevolutOrder,
  getRevolutMerchantConfig,
} from "../_shared/revolutOrders.ts";
import {
  assertExtraPaymentAmountTrusted,
  resolveExtraPaymentChargePence,
} from "../_shared/extraPaymentRecoverySSOT.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid(),
  amount_pence: z.number().int().positive().optional(),
  reason: z.string().trim().min(5).max(1000),
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.response;

    let body: unknown;
    try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }
    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) return jsonResponse({ error: "Invalid input", details: parsed.error.flatten() }, 400);
    const { trip_id, amount_pence, reason } = parsed.data;

    const { secretKey, environment } = getRevolutMerchantConfig();

    const { data: trip, error: tripErr } = await gate.supabase
      .from("trips")
      .select(
        "id, trip_number, passenger_id, driver_id, provider_order_id, outstanding_balance_pence, "
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
    if (paymentsErr) return jsonResponse({ error: "Failed to load trip payments" }, 500);

    const recovery = resolveExtraPaymentChargePence({ trip, payments: paymentRows ?? [] });
    const amountMismatch = assertExtraPaymentAmountTrusted(amount_pence, recovery.charge_pence);
    if (amountMismatch) return jsonResponse({ error: amountMismatch }, 400);

    if (recovery.charge_pence <= 0) {
      return jsonResponse({
        error: "Trip has no outstanding balance to collect",
        settlement_total_pence: recovery.settlement_total_pence,
        captured_total_pence: recovery.captured_total_pence,
        outstanding_balance_pence: 0,
      }, 400);
    }

    const chargePence = recovery.charge_pence;
    const currency = (trip.currency_code ?? trip.currency ?? "GBP").toUpperCase();

    if (!trip.passenger_id) {
      return jsonResponse({ error: "Trip has no passenger — cannot charge extra payment" }, 400);
    }

    // Create a new Revolut order (default auto-capture). The customer completes
    // it via the returned checkout_url/checkout_token in the customer app.
    const order = await createRevolutOrder({
      environment,
      secretKey,
      amountMinor: chargePence,
      currency,
      tripId: trip_id,
      description: `Extra payment for trip ${trip.trip_number ?? trip_id} — ${reason.slice(0, 80)}`,
      metadata: {
        type: "trip_extra_payment",
        trip_id,
        trip_number: trip.trip_number ?? "",
        parent_order_id: trip.provider_order_id ?? "",
        admin_reason: reason.slice(0, 400),
      },
    });

    const priorCaptured = Math.max(0, Number(trip.capture_amount_pence ?? 0));
    const outstanding = chargePence;

    await gate.supabase.from("payments").insert({
      trip_id,
      status: "requires_customer_action",
      amount_pence: chargePence,
      captured_amount_pence: 0,
      currency: currency.toLowerCase(),
      capture_method: "automatic",
      provider_charge_id: order.id,
      metadata: {
        source: "admin_extra_payment",
        provider: "revolut",
        revolut_order_id: order.id,
        revolut_checkout_token: order.token ?? order.public_id ?? null,
        revolut_checkout_url: order.checkout_url ?? null,
        parent_order_id: trip.provider_order_id ?? null,
        outstanding_before_pence: outstanding,
        admin_reason: reason,
      },
    });

    await gate.supabase.from("admin_payment_audit").insert({
      trip_id,
      admin_user_id: gate.userId,
      action: "extra_payment",
      reason,
      amount_pence_before: priorCaptured,
      amount_pence_after: priorCaptured, // nothing captured yet — webhook will update
      delta_pence: 0,
      provider: "revolut",
      provider_payment_id: order.id,
      metadata: {
        extra_order_id: order.id,
        parent_order_id: trip.provider_order_id ?? null,
        checkout_url: order.checkout_url ?? null,
        outstanding_before_pence: outstanding,
        settlement_total_pence: recovery.settlement_total_pence,
        captured_total_pence: recovery.captured_total_pence,
        recovery_source: recovery.source,
      },
    });

    return jsonResponse({
      success: true,
      requires_customer_action: true,
      provider: "revolut",
      revolut_order_id: order.id,
      revolut_checkout_token: order.token ?? order.public_id ?? null,
      revolut_checkout_url: order.checkout_url ?? null,
      charged_pence: chargePence,
      outstanding_balance_pence: outstanding,
      settlement_total_pence: recovery.settlement_total_pence,
      captured_before_pence: recovery.captured_total_pence,
      recovery_source: recovery.source,
      message: `Extra payment order created for ${(chargePence / 100).toFixed(2)}. Send checkout link to the customer to complete.`,
    });
  } catch (e) {
    console.error("[admin-request-extra-payment] Error:", e);
    return jsonResponse({ error: (e as Error).message ?? String(e) }, 500);
  }
});
