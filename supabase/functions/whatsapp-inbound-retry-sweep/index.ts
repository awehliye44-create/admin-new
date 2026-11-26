/**
 * P7 M4 — WhatsApp inbound durable replay sweep (no Meta redelivery required).
 *
 * pg_cron (every 2 minutes) → net.http_post. Service-role / cron-secret auth only.
 * Replays unprocessed `whatsapp_inbound_messages` rows older than 2 minutes with
 * attempt_count < 3 through the same claim RPC + workflow the webhook uses; exhausted rows get
 * a durable WHATSAPP_INBOUND_RETRY_EXHAUSTED alert.
 *
 * Body (optional): { dry_run?: boolean, limit?: number }
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import { runWhatsAppInboundRetrySweep } from "./lib/sweepCore.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
  "Content-Type": "application/json",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* empty body ok */
  }

  const auth = await assertCronOrServiceRoleAuth(req, body);
  if (!auth.ok) return auth.response;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  if (!supabaseUrl || !serviceKey) return json({ error: "db_unconfigured" }, 503);
  const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  try {
    const summary = await runWhatsAppInboundRetrySweep({
      client,
      limit: Number(body.limit ?? 20),
      dryRun: body.dry_run === true,
    });
    console.info("[whatsapp-inbound-retry-sweep] done", summary);
    return json({ ok: true, dry_run: body.dry_run === true, ...summary });
  } catch (err) {
    console.error("[whatsapp-inbound-retry-sweep] failed", String(err));
    return json({ ok: false, error: "sweep_failed" }, 500);
  }
});
