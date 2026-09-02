/**
 * admin-payment-sessions request handler — truthful HTTP statuses.
 * Success 200; auth 401; forbidden 403; bad input/scope 400;
 * provider inspect failure 502; unexpected 500.
 */
import { z } from "https://esm.sh/zod@3.23.8";
import {
  jsonResponse,
  requireAdminOrStaff,
  type GateError,
  type GateResult,
} from "../_shared/adminPaymentGate.ts";
import { listAdminPaymentSessions } from "../_shared/adminPaymentSessionsListSSOT.ts";
import { FINANCIAL_MODEL, resolveServiceAreaFinancialScope } from "../_shared/financialModelScopeGate.ts";

export const AdminPaymentSessionsInputSchema = z.object({
  tab: z.preprocess(
    (value) => (value === "recovery" ? "failed_recovery" : value),
    z.enum([
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
    ]).optional().default("captured"),
  ),
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
  driver_credit_exceptions_only: z.boolean().nullable().optional(),
});

export type AdminPaymentSessionsParsed = z.infer<typeof AdminPaymentSessionsInputSchema>;

const DEGRADED_SUMMARY = {
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
  gross_overcapture_pence: null,
  resolved_overcapture_pence: null,
  outstanding_customer_overcharge_pence: null,
  refund_beyond_gross_overcapture_pence: null,
  missing_payment_sessions_count: 0,
  released_buffer_total_pence: null,
  refunded_total_pence: null,
  provider_fees_total_pence: null,
  gross_onecab_commission_pence: null,
  net_onecab_commission_pence: null,
  driver_net_total_pence: null,
};

export type AdminPaymentSessionsHandlerDeps = {
  requireAuth: (req: Request) => Promise<GateResult | GateError>;
  // Deno + esm.sh SupabaseClient type skew — keep injectable deps loose.
  // deno-lint-ignore no-explicit-any
  listSessions: (supabase: any, request: any) => Promise<any>;
  // deno-lint-ignore no-explicit-any
  resolveScope: (supabase: any, model: any, serviceAreaId: string | null) => Promise<any>;
  inspectProviderOrder: (args: {
    // deno-lint-ignore no-explicit-any
    supabase: any;
    orderId: string;
  }) => Promise<Record<string, unknown>>;
};

export const defaultAdminPaymentSessionsDeps: AdminPaymentSessionsHandlerDeps = {
  requireAuth: requireAdminOrStaff,
  listSessions: listAdminPaymentSessions,
  resolveScope: resolveServiceAreaFinancialScope,
  inspectProviderOrder: async ({ supabase, orderId }) => {
    const { retrieveRevolutOrder } = await import("../_shared/revolutOrders.ts");
    const { resolveRevolutMerchantContext } = await import("../_shared/revolutMerchantContext.ts");
    const { sanitiseRevolutOrder } = await import("../../../shared/sanitisedProviderSnapshot.ts");
    const merchant = await resolveRevolutMerchantContext(supabase, "live");
    const order = await retrieveRevolutOrder(
      merchant.environment,
      merchant.secretKey,
      orderId,
    );
    return sanitiseRevolutOrder(order as unknown as Record<string, unknown>);
  },
};

/** Ensure gate failure bodies include success:false while preserving status. */
export async function gateFailureJsonResponse(gate: GateError): Promise<Response> {
  let payload: Record<string, unknown> = { success: false, error: "Unauthorized" };
  try {
    const parsed = await gate.response.clone().json();
    if (parsed && typeof parsed === "object") {
      payload = { success: false, ...(parsed as Record<string, unknown>) };
    }
  } catch {
    // keep default
  }
  return jsonResponse(payload, gate.response.status);
}

export async function handleAdminPaymentSessions(
  req: Request,
  deps: AdminPaymentSessionsHandlerDeps = defaultAdminPaymentSessionsDeps,
): Promise<Response> {
  try {
    const gate = await deps.requireAuth(req);
    if (!gate.ok) return await gateFailureJsonResponse(gate);

    let body: unknown = {};
    if (req.method === "POST") {
      try {
        body = await req.json();
      } catch {
        body = {};
      }
    }

    const parsed = AdminPaymentSessionsInputSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(
        { success: false, error: "Invalid input", details: parsed.error.flatten() },
        400,
      );
    }

    if (parsed.data.inspect_provider_order_id) {
      try {
        const sanitised = await deps.inspectProviderOrder({
          supabase: gate.supabase,
          orderId: parsed.data.inspect_provider_order_id,
        });
        return jsonResponse({
          success: true,
          sanitised_provider_state: sanitised,
        });
      } catch (err) {
        return jsonResponse({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          provider_verification_message:
            "Provider Sync Pending — showing last verified database state. Verified values were not overwritten.",
        }, 502);
      }
    }

    // PIPELINE 1 isolation — Payment Sessions is PLATFORM_COLLECTED only.
    const scope = await deps.resolveScope(
      gate.supabase,
      FINANCIAL_MODEL.PLATFORM_COLLECTED,
      parsed.data.service_area_id ?? null,
    );
    if (!scope.ok) {
      return jsonResponse(
        { success: false, error: scope.error, error_code: scope.code, code: scope.code },
        400,
      );
    }

    const result = await deps.listSessions(gate.supabase, {
      ...parsed.data,
      allowed_service_area_ids: scope.allowedServiceAreaIds,
    });
    return jsonResponse(result);
  } catch (err) {
    console.error("[admin-payment-sessions]", err);
    return jsonResponse({
      success: false,
      error: err instanceof Error ? err.message : String(err),
      page_status: "DEGRADED",
      tab: "overview",
      rows: [],
      summary: DEGRADED_SUMMARY,
    }, 500);
  }
}
