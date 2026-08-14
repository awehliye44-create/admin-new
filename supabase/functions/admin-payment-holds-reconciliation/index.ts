import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdminOrStaff } from "../_shared/adminPaymentGate.ts";
import { listPaymentHoldsRequiringAttention } from "../_shared/paymentHoldReconciliationSSOT.ts";

const InputSchema = z.object({
  refresh_provider_state: z.boolean().optional().default(true),
  view: z.enum(["attention", "history", "all"]).optional().default("attention"),
  limit: z.number().int().min(1).max(200).optional(),
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
    } else if (req.method === "GET") {
      const url = new URL(req.url);
      body = {
        refresh_provider_state: url.searchParams.get("refresh_provider_state") !== "0",
        view: url.searchParams.get("view") ?? "attention",
      };
    }

    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ success: false, error: "Invalid input", details: parsed.error.flatten() }, 400);
    }

    const holds = await listPaymentHoldsRequiringAttention(gate.supabase, {
      refreshProviderState: parsed.data.refresh_provider_state,
      view: parsed.data.view,
      limit: parsed.data.limit,
    });

    return jsonResponse({
      success: true,
      payment_holds_requiring_attention: holds.rows,
      payment_holds_history: holds.history_rows,
      summary: holds.summary,
    });
  } catch (err) {
    console.error("[admin-payment-holds-reconciliation]", err);
    return jsonResponse({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});
