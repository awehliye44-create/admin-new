// Admin: force-refresh provider state for active/at-risk payment sessions.
// Fetches Revolut order state via GET /orders/{id} and updates our sessions
// to reflect the ground truth. Never mutates already-terminal rows.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import { getRevolutMerchantConfig, retrieveRevolutOrder } from "../_shared/revolutOrders.ts";

// Statuses we consider still "in flight" and safe to reconcile.
const ACTIVE_STATUSES = [
  "pending_payment",
  "payment_authorised",
  "completed_pending_capture",
  "dispatching",
  "trip_created",
  "processing",
];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.response;

    let body: { session_ids?: string[] } = {};
    try { body = (await req.json()) ?? {}; } catch { /* optional */ }

    const query = gate.supabase
      .from("payment_sessions")
      .select("id, provider_order_id, status, provider_state, authorised_amount_pence, trip_id")
      .eq("provider", "revolut")
      .not("provider_order_id", "is", null);

    const { data: sessions, error } = Array.isArray(body.session_ids) && body.session_ids.length > 0
      ? await query.in("id", body.session_ids)
      : await query.or(
          `status.in.(${ACTIVE_STATUSES.join(",")}),provider_state.in.(AUTHORISED,PENDING,PROCESSING,UNKNOWN)`,
        );

    if (error) return jsonResponse({ error: error.message }, 500);
    if (!sessions?.length) return jsonResponse({ ok: true, refreshed: 0, results: [] });

    const { secretKey, environment } = getRevolutMerchantConfig();
    const nowIso = new Date().toISOString();
    const results: Array<Record<string, unknown>> = [];

    for (const s of sessions) {
      try {
        const order = await retrieveRevolutOrder(environment, secretKey, s.provider_order_id!);
        const stateUpper = String(order.state ?? "").toUpperCase();

        const update: Record<string, unknown> = {
          provider_state: stateUpper || null,
          provider_state_verified_at: nowIso,
          provider_state_verified_by: "admin_refresh",
          updated_at: nowIso,
        };

        // Only advance status if the session is not already terminal.
        if (["CANCELLED", "FAILED"].includes(stateUpper)) {
          update.status = stateUpper === "CANCELLED" ? "cancelled" : "failed";
          update.failure_reason = `REVOLUT_${stateUpper}`;
        } else if (stateUpper === "COMPLETED") {
          update.status = "captured";
        } else if (stateUpper === "AUTHORISED" && s.status === "pending_payment") {
          update.status = s.trip_id ? "trip_created" : "payment_authorised";
        }

        const { error: updErr } = await gate.supabase
          .from("payment_sessions")
          .update(update)
          .eq("id", s.id);

        results.push({
          session_id: s.id,
          provider_order_id: s.provider_order_id,
          previous_state: s.provider_state,
          new_state: stateUpper,
          previous_status: s.status,
          new_status: update.status ?? s.status,
          error: updErr?.message ?? null,
        });
      } catch (e) {
        results.push({
          session_id: s.id,
          provider_order_id: s.provider_order_id,
          error: (e as Error).message ?? String(e),
        });
      }
    }

    return jsonResponse({ ok: true, refreshed: results.length, environment, results });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message ?? String(e) }, 500);
  }
});
