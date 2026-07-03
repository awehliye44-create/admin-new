import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid(),
  reason: z.string().trim().min(5).max(2000),
  investigation_required: z.boolean().optional().default(false),
  adjustment_request: z.boolean().optional().default(false),
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

    const { trip_id, reason, investigation_required, adjustment_request } = parsed.data;

    const { data: trip, error: tripErr } = await gate.supabase
      .from("trips")
      .select("id, trip_code, payment_status, capture_amount_pence, refund_amount_pence, stripe_payment_intent_id")
      .eq("id", trip_id)
      .maybeSingle();

    if (tripErr || !trip) return jsonResponse({ error: "Trip not found" }, 404);

    const beforeSnapshot = {
      payment_status: trip.payment_status,
      capture_amount_pence: trip.capture_amount_pence ?? 0,
      refund_amount_pence: trip.refund_amount_pence ?? 0,
    };

    const { error: auditErr } = await gate.supabase.from("admin_payment_audit").insert({
      trip_id,
      admin_user_id: gate.userId,
      action: "finance_note",
      reason,
      amount_pence_before: beforeSnapshot.capture_amount_pence,
      amount_pence_after: beforeSnapshot.capture_amount_pence,
      delta_pence: 0,
      stripe_payment_intent_id: trip.stripe_payment_intent_id,
      metadata: {
        investigation_required,
        adjustment_request,
        before: beforeSnapshot,
        after: beforeSnapshot,
        note_only: true,
      },
    });

    if (auditErr) {
      return jsonResponse({ error: auditErr.message }, 500);
    }

    return jsonResponse({
      success: true,
      message: "Finance note recorded",
      trip_id,
      investigation_required,
      adjustment_request,
    });
  } catch (e) {
    console.error("[admin-add-trip-finance-note]", e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
