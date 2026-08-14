import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdminOrStaff } from "../_shared/adminPaymentGate.ts";
import { listRevolutOrphanReconciliationRows } from "../_shared/revolutOrphanPaymentsSSOT.ts";

/**
 * Revolut orphan / provider-only reconciliation.
 * Do NOT name this admin-finance-reconciliation — that name is owned by admin-new
 * Financial Reconciliation SSOT (GET finance_reconciliation_summary).
 */
const InputSchema = z.object({
  refresh_provider_state: z.boolean().optional().default(true),
  provider: z.enum(["revolut", "all"]).optional().default("revolut"),
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

    const { refresh_provider_state: refreshProviderState } = parsed.data;
    const revolut = await listRevolutOrphanReconciliationRows(gate.supabase, { refreshProviderState });

    return jsonResponse({
      success: true,
      provider_only_count: revolut.provider_only_count,
      total_pending_pence: revolut.total_pending_pence,
      revolut_provider_only: revolut.rows,
      summary: {
        revolut_orphan_count: revolut.provider_only_count,
        revolut_pending_pence: revolut.total_pending_pence,
      },
    });
  } catch (err) {
    console.error("[admin-revolut-orphan-reconciliation]", err);
    return jsonResponse({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});
