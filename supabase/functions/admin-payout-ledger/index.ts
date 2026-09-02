import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdminOrStaff, type GateError } from "../_shared/adminPaymentGate.ts";
import { listAdminPayoutLedger } from "../_shared/adminPayoutLedgerListSSOT.ts";
import { buildPayoutLedgerAccountsOverview } from "../_shared/adminPayoutLedgerAccountsOverviewSSOT.ts";
import { buildPayoutLedgerOverview } from "../_shared/adminPayoutLedgerOverviewSSOT.ts";
import { PAYOUT_LEDGER_ERROR } from "../../../shared/payoutLedgerOverviewSSOT.ts";
import { FINANCIAL_MODEL, resolveServiceAreaFinancialScope } from "../_shared/financialModelScopeGate.ts";

function livePayoutFlag(): boolean {
  return (Deno.env.get("LIVE_PAYOUT_EXECUTION_ENABLED") ?? "false").trim().toLowerCase() === "true";
}

/** Cursor/Lovable preview treats non-2xx edge responses as blank-screen RUNTIME_ERROR. */
async function gateFailureResponse(gate: GateError): Promise<Response> {
  let payload: Record<string, unknown> = { success: false, ok: false, error: "Unauthorized" };
  try {
    const parsed = await gate.response.json();
    if (parsed && typeof parsed === "object") {
      payload = { success: false, ok: false, ...(parsed as Record<string, unknown>) };
    }
  } catch {
    // keep default
  }
  return jsonResponse(payload, 200);
}

const HANDLER_BUDGET_MS = 25_000;

async function withHandlerBudget<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return await Promise.race([
    fn(),
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), HANDLER_BUDGET_MS);
    }),
  ]);
}

const InputSchema = z.object({
  mode: z.enum([
    "accounts_overview",
    "list",
    "ledger_overview",
    "company_list",
    "company_batches",
    "company_failed",
    "company_audit",
  ]).optional(),
  // Accept all PL top + driver tabs from the admin UI (do not 400 → blank screen).
  tab: z.enum([
    "overview",
    "driver_payouts",
    "company_transfers",
    "batch_history",
    "failed_transfers",
    "settings",
    "audit_history",
    "scheduled",
    "processing",
    "completed",
    "failed",
    "failures",
    "returned_cancelled",
    "batches",
    "history",
    "transfers",
    "connected_account",
    "statements",
    "audit_log",
  ]).optional().default("overview"),
  driver_id: z.string().uuid().nullable().optional(),
  service_area_id: z.string().uuid().nullable().optional(),
  status: z.string().nullable().optional(),
  payout_type: z.string().nullable().optional(),
  batch_id: z.string().uuid().nullable().optional(),
  date_from: z.string().nullable().optional(),
  date_to: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  credit_exceptions_only: z.boolean().nullable().optional(),
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const gate = await requireAdminOrStaff(req);
    if (!gate.ok) return await gateFailureResponse(gate);

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
      console.warn("[admin-payout-ledger] invalid input", parsed.error.flatten());
      return jsonResponse({
        success: true,
        ok: false,
        error: "Invalid input",
        error_code: "INVALID_INPUT",
        details: parsed.error.flatten(),
        page_status: "DEGRADED",
        tab: "overview",
        items: [],
        batches: [],
        accounts: [],
        company_transfers_read_only: true,
        live_payout_execution_enabled: livePayoutFlag(),
        summary: {
          total_items: 0,
          scheduled_count: 0,
          processing_count: 0,
          completed_count: 0,
          failed_count: 0,
          returned_cancelled_count: 0,
          pending_count: 0,
          scheduled_today_count: 0,
          paid_today_count: 0,
          paid_today_pence: null,
          total_paid_pence: null,
          total_failed_pence: null,
          total_paid_week_pence: null,
          total_paid_month_pence: null,
          total_paid_year_pence: null,
        },
      }, 200);
    }

    // PIPELINE 1 isolation — Payout Ledger is PLATFORM_COLLECTED only.
    // Driver-Collected service areas have no payout workflow.
    const scope = await resolveServiceAreaFinancialScope(
      gate.supabase,
      FINANCIAL_MODEL.PLATFORM_COLLECTED,
      parsed.data.service_area_id ?? null,
    );
    if (!scope.ok) {
      return jsonResponse({
        success: true,
        ok: false,
        error: scope.error,
        error_code: scope.code,
        page_status: "DEGRADED",
        tab: parsed.data.tab,
        items: [],
        batches: [],
        accounts: [],
        company_transfers: [],
        company_batches: [],
        company_audit_rows: [],
        company_transfers_read_only: true,
      }, 200);
    }

    const scopedRequest = {
      ...parsed.data,
      service_area_id: scope.serviceAreaId,
      allowed_service_area_ids: scope.allowedServiceAreaIds,
    };

    if (parsed.data.mode === "accounts_overview") {
      const overview = await withHandlerBudget("accounts_overview", () =>
        buildPayoutLedgerAccountsOverview(gate.supabase, {
          service_area_id: scopedRequest.service_area_id ?? null,
          allowed_service_area_ids: scopedRequest.allowed_service_area_ids,
          limit: parsed.data.limit,
        }));
      return jsonResponse(overview);
    }

    // Explicit Overview route — never fall through to list without overview_summary.
    if (parsed.data.mode === "ledger_overview") {
      const overview = await withHandlerBudget("ledger_overview", () =>
        buildPayoutLedgerOverview(gate.supabase, {
          service_area_id: scopedRequest.service_area_id ?? null,
          allowed_service_area_ids: scopedRequest.allowed_service_area_ids,
          limit: parsed.data.limit,
        }));
      return jsonResponse(overview);
    }

    const result = await withHandlerBudget("payout_ledger_list", () =>
      listAdminPayoutLedger(gate.supabase, scopedRequest));
    return jsonResponse(result);
  } catch (err) {
    const timedOut = err instanceof Error && err.message.endsWith("_TIMEOUT");
    console.error("[admin-payout-ledger]", err);
    // Never crash the full Payout Ledger UI with a generic non-2xx.
    // Return HTTP 200 + structured DEGRADED payload so independent tabs can still render.
    return jsonResponse({
      success: true,
      error: timedOut
        ? "Payout ledger request timed out — try narrowing the service area filter."
        : err instanceof Error ? err.message : String(err),
      error_code: timedOut ? "PAYOUT_LEDGER_TIMEOUT" : PAYOUT_LEDGER_ERROR.API_UNAVAILABLE,
      page_status: "DEGRADED",
      tab: "overview",
      items: [],
      batches: [],
      company_transfers: [],
      company_batches: [],
      company_audit_rows: [],
      company_transfers_read_only: true,
      live_payout_execution_enabled: livePayoutFlag(),
      summary: {
        total_items: 0,
        scheduled_count: 0,
        processing_count: 0,
        completed_count: 0,
        failed_count: 0,
        returned_cancelled_count: 0,
        pending_count: 0,
        scheduled_today_count: 0,
        paid_today_count: 0,
        paid_today_pence: null,
        total_paid_pence: null,
        total_failed_pence: null,
        total_paid_week_pence: null,
        total_paid_month_pence: null,
        total_paid_year_pence: null,
      },
    }, 200);
  }
});
