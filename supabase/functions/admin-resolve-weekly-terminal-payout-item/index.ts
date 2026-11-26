/**
 * Admin: resolve ONE weekly payout item stranded by a provider terminal failure (P7 M3).
 *
 * POST { payout_item_id: uuid }
 *   1. GET-reconciles the provider transaction first.
 *   2. If still terminal failed → public.fail_submitted_weekly_payout_item (ONE item, ONE reservation).
 * Admin JWT required (user_roles admin). Never calls Revolut /pay. No other batch item is touched.
 */
import { requireAdmin } from "../_shared/adminPaymentGate.ts";
import { resolveWeeklyTerminalPayoutItem } from "./lib/resolveWeeklyTerminal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Content-Type": "application/json",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const payoutItemId = typeof body.payout_item_id === "string" ? body.payout_item_id.trim() : "";
  if (!UUID_RE.test(payoutItemId)) return json({ error: "payout_item_id_required" }, 400);

  try {
    const result = await resolveWeeklyTerminalPayoutItem({
      supabase: gate.supabase,
      payoutItemId,
      actorUserId: gate.userId === "service-role" ? null : gate.userId,
    });
    return json(result, result.ok ? 200 : 409);
  } catch (err) {
    console.error("[admin-resolve-weekly-terminal-payout-item] failed", err);
    return json({ error: "internal_error" }, 500);
  }
});
