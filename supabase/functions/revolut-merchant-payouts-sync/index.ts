// Fetches recent payouts from the Revolut Merchant API and upserts them into
// public.revolut_merchant_payouts for admin reconciliation.
//
// Admin-only. Uses REVOLUT_MERCHANT_SECRET_KEY.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { listRevolutMerchantPayouts } from "../_shared/revolutApi.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ error: "missing_auth" }, 401);
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: "unauthorized" }, 401);

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: roleRow } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userData.user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) return json({ error: "forbidden" }, 403);

    const secretKey = Deno.env.get("REVOLUT_MERCHANT_SECRET_KEY");
    if (!secretKey) return json({ error: "missing_revolut_secret" }, 500);

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const limit = Math.min(Number(body.limit) || 100, 1000);
    const fromCreated: string | undefined = body.from_created;
    const toCreated: string | undefined = body.to_created;

    const payouts = await listRevolutMerchantPayouts({
      environment: "live",
      secretKey,
      limit,
      fromCreated,
      toCreated,
    });

    if (payouts.length === 0) {
      return json({ synced: 0, payouts: [] });
    }

    const rows = payouts.map((p) => ({
      revolut_payout_id: p.id,
      state: String(p.state ?? "UNKNOWN"),
      amount_minor: Number(p.amount ?? 0),
      currency: String(p.currency ?? "GBP").toUpperCase(),
      scheduled_for: p.scheduled_for ?? null,
      completed_at: p.completed_at ?? null,
      reference: p.reference ?? null,
      raw: p,
      fetched_at: new Date().toISOString(),
    }));

    const { error: upsertErr } = await admin
      .from("revolut_merchant_payouts")
      .upsert(rows, { onConflict: "revolut_payout_id" });
    if (upsertErr) return json({ error: "upsert_failed", detail: upsertErr.message }, 500);

    return json({ synced: rows.length, payouts: rows.map((r) => r.revolut_payout_id) });
  } catch (err) {
    const status = typeof err === "object" && err && "status" in err ? Number((err as { status: number }).status) : 500;
    const message = typeof err === "object" && err && "message" in err ? String((err as { message: string }).message) : String(err);
    return json({ error: "revolut_error", message }, status || 500);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
