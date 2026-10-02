import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import { recoverRevolutOrphanPayment } from "../_shared/revolutOrphanPaymentsSSOT.ts";

const InputSchema = z.object({
  provider_order_id: z.string().trim().min(1),
  action: z.enum(["cancel", "refund", "link"]),
  dry_run: z.boolean().optional().default(false),
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

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const result = await recoverRevolutOrphanPayment(gate.supabase, {
      providerOrderId: parsed.data.provider_order_id,
      action: parsed.data.action,
      adminUserId: gate.userId,
      dryRun: parsed.data.dry_run,
      supabaseUrl,
      serviceRoleKey,
    });

    return jsonResponse({ success: true, ...result });
  } catch (err) {
    console.error("[admin-recover-revolut-orphan]", err);
    return jsonResponse({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }, 400);
  }
});
