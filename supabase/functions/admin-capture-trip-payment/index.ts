// Admin: capture a Revolut order for a trip.
// Uses Revolut Merchant Orders API (Phase 2). Legacy Stripe path removed.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import {
  captureRevolutOrder,
  retrieveRevolutOrder,
  getRevolutMerchantConfig,
  mapRevolutStateToPaymentStatus,
} from "../_shared/revolutOrders.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid(),
  amount_pence: z.number().int().positive().optional(),
  reason: z.string().trim().min(5).max(1000),
});

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.response;

    let body: unknown;
    try { body = await req.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) return jsonResponse({ error: 'Invalid input', details: parsed.error.flatten() }, 400);
    const { trip_id, amount_pence, reason } = parsed.data;

    const { secretKey, environment } = getRevolutMerchantConfig();

    const { data: trip, error: tripErr } = await gate.supabase
      .from('trips')
      .select('id, provider_order_id, payment_provider, capture_amount_pence, authorised_amount_pence, payment_status, currency_code, currency')
      .eq('id', trip_id)
      .single();
    if (tripErr || !trip) return jsonResponse({ error: 'Trip not found' }, 404);
    if (!trip.provider_order_id) {
      return jsonResponse({ error: 'Trip has no Revolut order' }, 400);
    }

    const orderBefore = await retrieveRevolutOrder(environment, secretKey, trip.provider_order_id);
    const state = (orderBefore.state ?? '').toUpperCase();
    if (state !== 'AUTHORISED') {
      return jsonResponse({ error: `Cannot capture — Revolut order state is "${state}"` }, 400);
    }

    const authorisedTotal = Number(orderBefore.amount ?? trip.authorised_amount_pence ?? 0);
    const captureAmount = amount_pence ?? authorisedTotal;
    if (captureAmount <= 0) return jsonResponse({ error: 'amount_pence must be > 0' }, 400);
    if (captureAmount > authorisedTotal) {
      return jsonResponse({ error: `amount_pence (${captureAmount}) exceeds authorised (${authorisedTotal})` }, 400);
    }

    const before = trip.capture_amount_pence ?? 0;
    const captured = await captureRevolutOrder(environment, secretKey, trip.provider_order_id, captureAmount);

    await gate.supabase
      .from('trips')
      .update({
        payment_status: mapRevolutStateToPaymentStatus(captured.state) ?? 'captured',
        capture_amount_pence: captureAmount,
        provider_charge_id: captured.id ?? trip.provider_order_id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', trip_id);

    await gate.supabase.from('admin_payment_audit').insert({
      trip_id,
      admin_user_id: gate.userId,
      action: 'capture',
      reason,
      amount_pence_before: before,
      amount_pence_after: captureAmount,
      delta_pence: captureAmount - before,
      provider: 'revolut',
      provider_payment_id: trip.provider_order_id,
      metadata: {
        authorised_total: authorisedTotal,
        requested_amount: amount_pence ?? null,
        revolut_state: captured.state,
      },
    });

    return jsonResponse({
      success: true,
      provider: 'revolut',
      provider_order_id: trip.provider_order_id,
      captured_pence: captureAmount,
      state: captured.state,
      message: `Captured ${(captureAmount / 100).toFixed(2)} successfully`,
    });
  } catch (e) {
    console.error('[admin-capture-trip-payment] Error:', e);
    return jsonResponse({ error: (e as Error).message ?? String(e) }, 500);
  }
});
