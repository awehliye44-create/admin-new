// Admin: read-only Payment Authorisation Lifecycle audit for a trip.
// Returns parent hold state, recovery order state, and release trigger.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import { getRevolutMerchantConfig, retrieveRevolutOrder } from "../_shared/revolutOrders.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid().optional(),
  trip_code: z.string().min(3).max(64).optional(),
}).refine((v) => v.trip_id || v.trip_code, { message: "trip_id or trip_code required" });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.response;

    const url = new URL(req.url);
    const raw = req.method === "GET"
      ? { trip_id: url.searchParams.get("trip_id") ?? undefined, trip_code: url.searchParams.get("trip_code") ?? undefined }
      : await req.json().catch(() => ({}));
    const parsed = InputSchema.safeParse(raw);
    if (!parsed.success) return jsonResponse({ error: "Invalid input", details: parsed.error.flatten() }, 400);

    let query = gate.supabase.from("v_payment_lifecycle_audit").select("*").limit(1);
    if (parsed.data.trip_id) query = query.eq("trip_id", parsed.data.trip_id);
    else query = query.eq("trip_code", parsed.data.trip_code!);
    const { data, error } = await query.maybeSingle();
    if (error) return jsonResponse({ error: error.message }, 500);
    if (!data) return jsonResponse({ error: "trip_not_found" }, 404);

    // Enrich with live provider state when possible.
    let parent_provider_live: unknown = null;
    let recovery_provider_live: unknown = null;
    try {
      const { secretKey, environment } = getRevolutMerchantConfig();
      if (data.parent_order_id) {
        const o = await retrieveRevolutOrder(environment, secretKey, String(data.parent_order_id));
        parent_provider_live = { state: o.state, amount: o.amount, captured_amount: (o as { captured_amount?: unknown }).captured_amount ?? null };
      }
      if (data.recovery_order_id) {
        const o = await retrieveRevolutOrder(environment, secretKey, String(data.recovery_order_id));
        recovery_provider_live = { state: o.state, amount: o.amount, captured_amount: (o as { captured_amount?: unknown }).captured_amount ?? null };
      }
    } catch (e) {
      console.warn("[admin-payment-lifecycle-audit] provider fetch failed:", (e as Error).message);
    }

    return jsonResponse({
      trip: { id: data.trip_id, code: data.trip_code, payment_status: data.trip_payment_status },
      parent_hold: {
        session_id: data.parent_session_id,
        order_id: data.parent_order_id,
        provider_state: data.parent_provider_state,
        status: data.parent_status,
        authorised_amount_pence: data.authorised_amount_pence,
        captured_amount_pence: data.captured_amount_pence,
        additional_auth_status: data.additional_auth_status,
        release_trigger: data.release_trigger,
        release_trigger_at: data.release_trigger_at,
        live: parent_provider_live,
      },
      recovery: {
        session_id: data.recovery_session_id,
        order_id: data.recovery_order_id,
        status: data.recovery_status,
        captured_pence: data.recovery_captured_pence,
        created_at: data.recovery_created_at,
        live: recovery_provider_live,
      },
      invariant: {
        // Proof: an AUTHORISED parent is never released automatically. If parent
        // is terminal, release_trigger must be one of the four canonical values.
        holds_protected: data.parent_provider_state === "AUTHORISED" || ["capture_success","recovery_captured","admin_abandon_recovery","provider_expired"].includes(String(data.release_trigger ?? "")),
      },
    });
  } catch (e) {
    console.error("[admin-payment-lifecycle-audit] Error:", e);
    return jsonResponse({ error: (e as Error).message ?? String(e) }, 500);
  }
});
