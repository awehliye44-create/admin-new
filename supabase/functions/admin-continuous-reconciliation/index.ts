/**
 * Continuous reconciliation — compare wallet/payout SSOT vs backend records.
 * P0: Stripe Connect sync retired; snapshots use Driver Wallet Ledger only.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { fetchDriverWalletPayoutSnapshot } from "../_shared/fetchDriverWalletPayoutSnapshot.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

async function requireAdmin(req: Request): Promise<Response | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const token = authHeader.replace("Bearer ", "");
  const anon = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data, error } = await anon.auth.getUser(token);
  if (error || !data?.user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const svc = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: role } = await svc
    .from("user_roles")
    .select("role")
    .eq("user_id", data.user.id)
    .eq("role", "admin")
    .maybeSingle();
  if (!role) {
    return new Response(JSON.stringify({ error: "Forbidden — admin required" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return null;
}

type ReconciliationRow = {
  driver_id: string;
  driver_code: string | null;
  classification: "matched" | "pending" | "mismatch" | "failed" | "local_only" | "stripe_only";
  reasons: string[];
  wallet_owed_pence: number;
  stripe_available_pence: number | null;
  stripe_paid_out_pence: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const gate = await requireAdmin(req);
  if (gate) return gate;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const regionId = body.region_id as string | undefined;

    // P0 Stripe retirement: never sync Connect payouts or pass Stripe client into snapshots.

    let driversQuery = supabase
      .from("drivers")
      .select("id, driver_code, region_id")
      .limit(100);
    if (regionId) driversQuery = driversQuery.eq("region_id", regionId);

    const { data: drivers } = await driversQuery;
    const rows: ReconciliationRow[] = [];

    for (const d of drivers ?? []) {
      const snap = await fetchDriverWalletPayoutSnapshot(supabase, {
        driverId: d.id,
        stripe: null,
      });

      let classification: ReconciliationRow["classification"] = "matched";
      if (snap.reconciliation_status === "LOCAL_ONLY") classification = "local_only";
      else if (snap.reconciliation_status === "STRIPE_ONLY") classification = "stripe_only";
      else if (snap.reconciliation_status === "MISMATCH" || snap.reconciliation_status === "PROVIDER_NEGATIVE") {
        classification = "mismatch";
      } else if (snap.included_in_payout_batch_amount_pence > 0) {
        classification = "pending";
      }

      rows.push({
        driver_id: d.id,
        driver_code: d.driver_code as string | null,
        classification,
        reasons: snap.reconciliation_reasons,
        wallet_owed_pence: snap.current_onecab_wallet_owed_pence,
        stripe_available_pence: snap.stripe_connect_available_pence,
        stripe_paid_out_pence: snap.stripe_paid_out_total_pence,
      });
    }

    const summary = {
      matched: rows.filter((r) => r.classification === "matched").length,
      pending: rows.filter((r) => r.classification === "pending").length,
      mismatch: rows.filter((r) => r.classification === "mismatch").length,
      local_only: rows.filter((r) => r.classification === "local_only").length,
      stripe_only: rows.filter((r) => r.classification === "stripe_only").length,
      failed: rows.filter((r) => r.classification === "failed").length,
    };

    return new Response(JSON.stringify({
      success: true,
      ran_at: new Date().toISOString(),
      summary,
      rows,
      repair_mode: body.repair_mode === true,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[admin-continuous-reconciliation]", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
