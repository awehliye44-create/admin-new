import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdminOrStaff } from "../_shared/adminPaymentGate.ts";
import { listAdminPaymentSessions } from "../_shared/adminPaymentSessionsListSSOT.ts";

const InputSchema = z.object({
  tab: z.enum([
    "overview",
    "active_holds",
    "captured",
    "released",
    "refunded",
    "failed_recovery",
    "history",
    "provider_payments",
    "completed_trips_paid",
    "payment_matching",
  ]).optional().default("overview"),
  refresh_provider_state: z.boolean().optional().default(false),
  inspect_provider_order_id: z.string().nullable().optional(),
  service_area_id: z.string().uuid().nullable().optional(),
  provider: z.string().nullable().optional(),
  payment_method: z.string().nullable().optional(),
  purpose: z.string().nullable().optional(),
  session_status: z.string().nullable().optional(),
  provider_state: z.string().nullable().optional(),
  has_trip: z.boolean().nullable().optional(),
  active_hold: z.boolean().nullable().optional(),
  release_failed: z.boolean().nullable().optional(),
  recovery_pending: z.boolean().nullable().optional(),
  legacy_evidence: z.boolean().nullable().optional(),
  provider_fees_pending: z.boolean().nullable().optional(),
  capture_failed: z.boolean().nullable().optional(),
  money_at_risk: z.boolean().nullable().optional(),
  match_status: z.string().nullable().optional(),
  customer_id: z.string().uuid().nullable().optional(),
  date_from: z.string().nullable().optional(),
  date_to: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).max(10000).optional(),
  payment_session_id: z.string().uuid().nullable().optional(),
  provider_order_id: z.string().nullable().optional(),
  trip_id: z.string().uuid().nullable().optional(),
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const gate = await requireAdminOrStaff(req);
    if (!gate.ok) return gate.response;

    let body: unknown = {};
    if (req.method === "POST") {
      try {
        body = await req.json();
      } catch {
        body = {};
      }
    }

    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ success: false, error: "Invalid input", details: parsed.error.flatten() }, 400);
    }

    if (parsed.data.inspect_provider_order_id) {
      const { retrieveRevolutOrder } = await import("../_shared/revolutOrders.ts");
      const { resolveRevolutMerchantContext } = await import("../_shared/revolutMerchantContext.ts");
      const { sanitiseRevolutOrder } = await import("../../../shared/sanitisedProviderSnapshot.ts");
      try {
        const merchant = await resolveRevolutMerchantContext(gate.supabase, "live");
        const order = await retrieveRevolutOrder(
          merchant.environment,
          merchant.secretKey,
          parsed.data.inspect_provider_order_id,
        );
        return jsonResponse({
          success: true,
          sanitised_provider_state: sanitiseRevolutOrder(order as unknown as Record<string, unknown>),
        });
      } catch (err) {
        return jsonResponse({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          provider_verification_message: "Provider Sync Pending — showing last verified database state. Verified values were not overwritten.",
        }, 502);
      }
    }

    const result = await listAdminPaymentSessions(gate.supabase, parsed.data);
    return jsonResponse(result);
  } catch (err) {
    console.error("[admin-payment-sessions]", err);
    return jsonResponse({
      success: false,
      error: err instanceof Error ? err.message : String(err),
      page_status: "DEGRADED",
      tab: "overview",
      rows: [],
      summary: {
        total: 0,
        active_hold_count: 0,
        active_hold_amount_pence: null,
        captured_count: 0,
        released_count: 0,
        refunded_count: 0,
        failed_recovery_count: 0,
        recovery_pending_count: 0,
        provider_fees_pending_count: 0,
        total_customer_revenue_captured_pence: null,
        total_authorised_pence: null,
        capture_success_rate_pct: null,
        money_at_risk_pence: null,
        red: 0,
        amber: 0,
        green: 0,
        unknown_count: 0,
        provider_captured_total_pence: null,
        completed_trip_fare_total_pence: null,
        matched_trips_count: 0,
        capture_shortfall_pence: null,
        overcaptured_amount_pence: null,
        missing_payment_sessions_count: 0,
        released_buffer_total_pence: null,
        refunded_total_pence: null,
        provider_fees_total_pence: null,
        gross_onecab_commission_pence: null,
        net_onecab_commission_pence: null,
        driver_net_total_pence: null,
      },
    }, 500);
  }
});
