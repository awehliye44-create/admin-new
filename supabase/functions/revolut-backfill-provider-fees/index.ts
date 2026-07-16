// Backfills provider_processing_fee_pence on captured Revolut payment_sessions
// (and mirrors to trips.provider_fee_pence) by fetching the Revolut order and
// summing payments[].fees[].amount. Admin-only. Idempotent — safe to re-run.
//
// POST { dry_run?: boolean, limit?: number, order_id?: string }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { revolutMerchantRequest } from "../_shared/revolutApi.ts";

function extractFeeMinor(order: unknown): number | null {
  if (!order || typeof order !== "object") return null;
  const payments = (order as { payments?: unknown }).payments;
  if (!Array.isArray(payments) || payments.length === 0) return null;
  let total = 0;
  let saw = false;
  for (const p of payments) {
    if (!p || typeof p !== "object") continue;
    const fees = (p as { fees?: unknown }).fees;
    if (Array.isArray(fees)) {
      for (const f of fees) {
        const amt = (f as { amount?: unknown })?.amount;
        if (typeof amt === "number" && Number.isFinite(amt)) { total += amt; saw = true; }
      }
      continue;
    }
    const flat = (p as { fee?: unknown }).fee;
    if (typeof flat === "number" && Number.isFinite(flat)) { total += flat; saw = true; }
  }
  return saw ? Math.round(total) : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "missing_auth" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: auth } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: "unauthorized" }, 401);

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: role } = await admin
    .from("user_roles").select("role")
    .eq("user_id", userData.user.id).eq("role", "admin").maybeSingle();
  if (!role) return json({ error: "forbidden" }, 403);

  const secretKey = Deno.env.get("REVOLUT_MERCHANT_SECRET_KEY")
    ?? Deno.env.get("REVOLUT_SECRET_KEY");
  if (!secretKey) return json({ error: "missing_revolut_secret" }, 500);

  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dry_run === true;
  const limit = Math.min(Number(body?.limit) || 100, 500);
  const specificOrderId = typeof body?.order_id === "string" ? body.order_id.trim() : null;

  let query = admin
    .from("payment_sessions")
    .select("id, trip_id, provider_order_id, provider_processing_fee_pence, provider_state")
    .eq("payment_provider", "revolut")
    .not("provider_order_id", "is", null)
    .is("provider_processing_fee_pence", null)
    .limit(limit);
  if (specificOrderId) query = query.eq("provider_order_id", specificOrderId);

  const { data: sessions, error: qErr } = await query;
  if (qErr) return json({ error: qErr.message }, 500);

  const results: Array<Record<string, unknown>> = [];
  let updated = 0;
  let skipped = 0;

  for (const s of sessions ?? []) {
    const orderId = s.provider_order_id as string;
    try {
      const order = await revolutMerchantRequest<unknown>(
        "live", secretKey, `/orders/${encodeURIComponent(orderId)}`, { method: "GET" },
      );
      const fee = extractFeeMinor(order);
      if (fee == null) {
        skipped++;
        results.push({ session_id: s.id, order_id: orderId, fee: null, action: "skipped_no_fee" });
        continue;
      }
      if (!dryRun) {
        const nowIso = new Date().toISOString();
        await admin.from("payment_sessions").update({
          provider_processing_fee_pence: fee,
          provider_fee_source: "revolut_backfill",
          provider_fee_confirmed_at: nowIso,
          updated_at: nowIso,
        }).eq("id", s.id);
        if (s.trip_id) {
          await admin.from("trips").update({
            provider_fee_pence: fee, updated_at: nowIso,
          }).eq("id", s.trip_id);
        }
      }
      updated++;
      results.push({ session_id: s.id, trip_id: s.trip_id, order_id: orderId, fee_pence: fee, action: dryRun ? "would_update" : "updated" });
    } catch (err) {
      results.push({ session_id: s.id, order_id: orderId, error: (err as Error).message, action: "error" });
    }
  }

  return json({ ok: true, dry_run: dryRun, scanned: sessions?.length ?? 0, updated, skipped, results });
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
