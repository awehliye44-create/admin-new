// Admin: cancel an authorised (uncaptured) Revolut order — releases the customer hold.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import {
  cancelRevolutOrder,
  retrieveRevolutOrder,
  getRevolutMerchantConfig,
} from "../_shared/revolutOrders.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid(),
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
    const { trip_id, reason } = parsed.data;

    const { secretKey, environment } = getRevolutMerchantConfig();

    const { data: trip, error: tripErr } = await gate.supabase
      .from('trips')
      .select('id, provider_order_id, authorised_amount_pence, payment_status')
      .eq('id', trip_id)
      .single();
    if (tripErr || !trip) return jsonResponse({ error: 'Trip not found' }, 404);
    if (!trip.provider_order_id) return jsonResponse({ error: 'Trip has no Revolut order' }, 400);

    const orderBefore = await retrieveRevolutOrder(environment, secretKey, trip.provider_order_id);
    const cancellable = ['PENDING', 'PROCESSING', 'AUTHORISED'];
    const state = (orderBefore.state ?? '').toUpperCase();
    if (!cancellable.includes(state)) {
      return jsonResponse({ error: `Cannot cancel — Revolut order state is "${state}"` }, 400);
    }

    const before = Number(orderBefore.amount ?? trip.authorised_amount_pence ?? 0);
    const cancelled = await cancelRevolutOrder(environment, secretKey, trip.provider_order_id);

    await gate.supabase
      .from('trips')
      .update({
        payment_status: 'cancelled',
        capture_amount_pence: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', trip_id);

    await gate.supabase.from('admin_payment_audit').insert({
      trip_id,
      admin_user_id: gate.userId,
      action: 'cancel',
      reason,
      amount_pence_before: before,
      amount_pence_after: 0,
      delta_pence: -before,
      provider: 'revolut',
      provider_payment_id: trip.provider_order_id,
      metadata: { previous_state: state, cancelled_state: cancelled.state },
    });

    return jsonResponse({
      success: true,
      provider: 'revolut',
      provider_order_id: trip.provider_order_id,
      released_pence: before,
      state: cancelled.state,
      message: `Hold released — ${(before / 100).toFixed(2)} returned to customer.`,
    });
  } catch (e) {
    console.error('[admin-cancel-trip-payment] Error:', e);
    return jsonResponse({ error: (e as Error).message ?? String(e) }, 500);
  }
});
