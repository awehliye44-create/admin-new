// Admin: cancel/release trip payment hold.
// Payment Authorisation Lifecycle SSOT — protects AUTHORISED holds while a
// PAYMENT_RECOVERY is in flight. Requires abandon_recovery=true to force-release.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import {
  cancelRevolutOrder,
  retrieveRevolutOrder,
  getRevolutMerchantConfig,
} from "../_shared/revolutOrders.ts";
import { resolveTripPaymentProvider, tripProviderOrderId } from "../_shared/tripPaymentProviderSSOT.ts";
import { assertStripeMutationAllowed } from "../_shared/stripeRuntimeDisabled.ts";
import { assertHoldReleaseAllowed, stampReleaseTrigger } from "../_shared/paymentHoldGuard.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid(),
  reason: z.string().trim().min(5).max(1000),
  abandon_recovery: z.boolean().optional().default(false),
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
    const { trip_id, reason, abandon_recovery } = parsed.data;

    const { data: trip, error: tripErr } = await gate.supabase
      .from("trips")
      .select("id, payment_provider, provider_order_id, stripe_payment_intent_id, authorised_amount_pence, payment_status")
      .eq("id", trip_id)
      .single();
    if (tripErr || !trip) return jsonResponse({ error: "Trip not found" }, 404);

    const provider = resolveTripPaymentProvider(trip);
    if (provider === "stripe") {
      const retired = assertStripeMutationAllowed(corsHeaders, "admin-cancel-trip-payment");
      if (retired) return retired;
      return jsonResponse({ error: "Stripe is permanently retired from active ONECAB finance.", error_code: "STRIPE_RETIRED" }, 422);
    }

    const orderId = tripProviderOrderId(trip);
    if (!orderId) return jsonResponse({ error: "Trip has no Revolut order" }, 400);

    // Payment Authorisation Lifecycle SSOT gate.
    const releaseTrigger = abandon_recovery ? "admin_abandon_recovery" : "capture_success";
    const guard = await assertHoldReleaseAllowed(gate.supabase, { tripId: trip_id, reason: releaseTrigger });
    if (!guard.allowed) {
      return jsonResponse({
        error: guard.message ?? "Hold protected",
        error_code: guard.reason_code,
        parent_session_id: guard.parent_session_id,
        recovery_session_id: guard.recovery_session_id,
        recovery_status: guard.recovery_status,
      }, 409);
    }

    const { secretKey, environment } = getRevolutMerchantConfig();
    const orderBefore = await retrieveRevolutOrder(environment, secretKey, orderId);
    const cancellable = ["PENDING", "PROCESSING", "AUTHORISED"];
    const state = (orderBefore.state ?? "").toUpperCase();
    if (!cancellable.includes(state)) {
      return jsonResponse({ error: `Cannot cancel — Revolut order state is "${state}"` }, 400);
    }

    const before = Number(orderBefore.amount ?? trip.authorised_amount_pence ?? 0);

    // Stamp release trigger BEFORE mutation so DB trigger accepts it.
    if (guard.parent_session_id) {
      await stampReleaseTrigger(gate.supabase, guard.parent_session_id, releaseTrigger, {
        abandon_recovery,
        admin_reason: reason,
      });
    }

    const cancelled = await cancelRevolutOrder(environment, secretKey, orderId);

    await gate.supabase.from("trips").update({
      payment_status: "cancelled",
      capture_amount_pence: 0,
      updated_at: new Date().toISOString(),
    }).eq("id", trip_id);

    await gate.supabase.from("admin_payment_audit").insert({
      trip_id,
      admin_user_id: gate.userId,
      action: abandon_recovery ? "abandon_recovery" : "cancel",
      reason,
      amount_pence_before: before,
      amount_pence_after: 0,
      delta_pence: -before,
      provider: "revolut",
      provider_payment_id: orderId,
      metadata: {
        previous_state: state,
        cancelled_state: cancelled.state,
        release_trigger: releaseTrigger,
        recovery_session_id: guard.recovery_session_id ?? null,
      },
    });

    return jsonResponse({
      success: true,
      provider: "revolut",
      provider_order_id: orderId,
      released_pence: before,
      release_trigger: releaseTrigger,
      state: cancelled.state,
      message: `Hold released — ${(before / 100).toFixed(2)} returned to customer.`,
    });
  } catch (e) {
    console.error("[admin-cancel-trip-payment] Error:", e);
    return jsonResponse({ error: (e as Error).message ?? String(e) }, 500);
  }
});
