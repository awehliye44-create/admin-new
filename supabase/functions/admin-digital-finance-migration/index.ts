// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ error: "Unauthorized" }, 401);
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Verify caller is authenticated
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userRes, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userRes?.user) return json({ error: "Unauthorized" }, 401);

    const uid = userRes.user.id;

    // Verify super_admin via service role (bypasses RLS)
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: roleRow } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", uid)
      .eq("role", "super_admin")
      .maybeSingle();
    if (!roleRow) return json({ error: "Forbidden: super_admin required" }, 403);

    // Dry-run preview support: ?preview=1
    const url = new URL(req.url);
    const preview = url.searchParams.get("preview") === "1";

    if (preview) {
      const [wallets, items, batches, auths, cashouts, settlements, era] = await Promise.all([
        admin.rpc("__digital_migration_noop").then(() => null).catch(() => null),
        admin.from("payout_items").select("id", { count: "exact", head: true })
          .in("status", ["pending","processing","CREATED","READY","BLOCKED"])
          .or("stripe_transfer_id.is.null,stripe_transfer_id.eq."),
        admin.from("payout_batches").select("id", { count: "exact", head: true })
          .in("status", ["pending","processing","CREATED","READY","BLOCKED"]),
        admin.from("payout_authorization").select("id", { count: "exact", head: true })
          .in("status", ["pending","executing","failed_retryable"]),
        admin.from("driver_early_cashouts").select("id", { count: "exact", head: true })
          .in("status", ["pending","processing"]),
        admin.from("driver_earning_settlement").select("id", { count: "exact", head: true })
          .eq("allocated_to_payout", false).neq("settlement_status", "settled"),
        admin.from("admin_settings").select("setting_value").eq("setting_key","finance_era").maybeSingle(),
      ]);
      return json({
        preview: true,
        current_era: (era.data?.setting_value as any) ?? "legacy_cash",
        payout_items_to_void: items.count ?? 0,
        payout_batches_to_archive: batches.count ?? 0,
        authorizations_to_cancel: auths.count ?? 0,
        early_cashouts_to_cancel: cashouts.count ?? 0,
        settlements_to_mark: settlements.count ?? 0,
      });
    }

    // Execute the migration via SECURITY DEFINER RPC (auth.uid() honored via caller JWT)
    const caller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data, error } = await caller.rpc("run_digital_finance_migration");
    if (error) return json({ error: error.message }, 400);

    return json({ ok: true, result: data });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
