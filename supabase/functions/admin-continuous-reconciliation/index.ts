/**
 * Continuous reconciliation — compare wallet/payout SSOT vs backend records.
 * P0: provider Connect sync retired; snapshots use Driver Wallet Ledger only.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { fetchDriverWalletPayoutSnapshot } from "../_shared/fetchDriverWalletPayoutSnapshot.ts";
import {
  corsHeaders,
  requireAdmin,
  requirePageAccess,
} from "../_shared/adminPaymentGate.ts";

type ReconciliationRow = {
  driver_id: string;
  driver_code: string | null;
  classification: "matched" | "pending" | "mismatch" | "failed" | "local_only" | "provider_only";
  reasons: string[];
  wallet_owed_pence: number;
  provider_available_pence: number | null;
  provider_paid_out_pence: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const adminGate = await requireAdmin(req);
  if (!adminGate.ok) return adminGate.response;
  const pageGate = await requirePageAccess(adminGate, "financial-reconciliation");
  if (!pageGate.ok) return pageGate.response;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const regionId = body.region_id as string | undefined;

    // P0 provider retirement: never sync Connect payouts or pass provider client into snapshots.

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
      });

      const reconciliationStatus = String(snap.reconciliation_status ?? "");
      let classification: ReconciliationRow["classification"] = "matched";
      if (reconciliationStatus === "LOCAL_ONLY") classification = "local_only";
      else if (reconciliationStatus === "PROVIDER_ONLY") classification = "provider_only";
      else if (reconciliationStatus === "MISMATCH" || reconciliationStatus === "PROVIDER_NEGATIVE") {
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
        provider_available_pence: snap.provider_available_pence,
        provider_paid_out_pence: snap.provider_paid_out_total_pence,
      });
    }

    const summary = {
      matched: rows.filter((r) => r.classification === "matched").length,
      pending: rows.filter((r) => r.classification === "pending").length,
      mismatch: rows.filter((r) => r.classification === "mismatch").length,
      local_only: rows.filter((r) => r.classification === "local_only").length,
      provider_only: rows.filter((r) => r.classification === "provider_only").length,
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
