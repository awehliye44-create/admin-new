// Admin: capture trip payment (Revolut) — canonical Payment Session ownership.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import { executeAdminCaptureTripPayment } from "../_shared/adminCaptureTripPaymentSSOT.ts";
import { ADMIN_CAPTURE_PRECONDITION } from "../_shared/adminCaptureTripPaymentPreconditions.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid(),
  amount_pence: z.number().int().positive().optional(),
  reason: z.string().trim().min(5).max(1000),
});

function httpStatusForErrorCode(code?: string): number {
  if (code === "CAPTURE_BLOCKED_NEVER_CAPTURE") return 409;
  if (code === ADMIN_CAPTURE_PRECONDITION.TRIP_NOT_COMPLETED) return 409;
  if (code === ADMIN_CAPTURE_PRECONDITION.FINANCIAL_MODEL_VIOLATION) return 409;
  if (code === "CAPTURE_BUSY") return 409;
  return 400;
}

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

    const { data: trip, error: tripErr } = await gate.supabase
      .from("trips")
      .select("*")
      .eq("id", trip_id)
      .single();
    if (tripErr || !trip) return jsonResponse({ error: "Trip not found" }, 404);

    const before = trip.capture_amount_pence ?? 0;
    const result = await executeAdminCaptureTripPayment({
      supabase: gate.supabase,
      trip: trip as Record<string, unknown>,
      amountPence: amount_pence,
    });

    if (result.success && result.capture_amount_pence != null) {
      await gate.supabase.from("admin_payment_audit").insert({
        trip_id,
        admin_user_id: gate.userId,
        action: "capture",
        reason,
        amount_pence_before: before,
        amount_pence_after: result.capture_amount_pence,
        delta_pence: result.capture_amount_pence - before,
        provider: "revolut",
        provider_payment_id: result.provider_order_id ?? null,
        metadata: {
          payment_session_id: result.payment_session_id ?? null,
          revolut_state: result.revolut_state ?? null,
          settlement_status: result.settlement_status ?? null,
          wallet_posting_status: result.wallet_posting_status ?? null,
          reconciliation_status: result.reconciliation_status ?? null,
          degraded: result.degraded ?? false,
        },
      });
    }

    if (!result.success) {
      return jsonResponse({
        success: false,
        error: result.error,
        error_code: result.error_code,
        payment_session_id: result.payment_session_id ?? null,
        retry_provider_capture: false,
      }, httpStatusForErrorCode(result.error_code));
    }

    return jsonResponse({
      success: true,
      provider: "revolut",
      provider_order_id: result.provider_order_id,
      payment_session_id: result.payment_session_id,
      captured_pence: result.capture_amount_pence,
      state: result.revolut_state,
      provider_capture_status: result.provider_capture_status,
      settlement_status: result.settlement_status,
      wallet_posting_status: result.wallet_posting_status,
      reconciliation_status: result.reconciliation_status,
      retry_provider_capture: false,
      degraded: result.degraded ?? false,
      message: result.message,
    });
  } catch (e) {
    console.error("[admin-capture-trip-payment] Error:", e);
    return jsonResponse({ error: (e as Error).message ?? String(e), retry_provider_capture: false }, 500);
  }
});
