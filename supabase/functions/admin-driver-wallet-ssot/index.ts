/**
 * Admin Driver Wallet SSOT — per-driver snapshot from distinct sources.
 * P0: No live Stripe Connect reads. Drivers listed without stripe_account_id filter.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { fetchDriverWalletPayoutSnapshot } from "../_shared/fetchDriverWalletPayoutSnapshot.ts";
import { fetchDriverWalletSummary } from "../_shared/fetchDriverWalletSummary.ts";
import { isStripeRuntimeDisabled } from "../_shared/stripeRuntimeDisabled.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: adminRole } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (!adminRole) {
      const { data: staffRow } = await supabase
        .from("staff_profiles")
        .select("id")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .maybeSingle();
      if (!staffRow) {
        return new Response(JSON.stringify({ error: "Forbidden — admin or staff role required" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const url = new URL(req.url);
    const driverId = body.driver_id ?? url.searchParams.get("driver_id");
    const regionId = body.region_id ?? url.searchParams.get("region_id");
    const mode = String(body.mode ?? url.searchParams.get("mode") ?? "");
    const periodKey = String(body.period ?? url.searchParams.get("period") ?? "week");
    const periodFrom = body.from ?? url.searchParams.get("from");
    const periodTo = body.to ?? url.searchParams.get("to");
    const serviceAreaId = body.service_area_id ?? url.searchParams.get("service_area_id");
    const limit = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Number(body.limit ?? url.searchParams.get("limit") ?? DEFAULT_PAGE_SIZE)),
    );
    const offset = Math.max(0, Number(body.offset ?? url.searchParams.get("offset") ?? 0));

    // P0: never pass a live Stripe client into wallet SSOT.
    const stripe = null;
    if (!isStripeRuntimeDisabled()) {
      console.warn("[admin-driver-wallet-ssot] Stripe runtime re-enabled — Connect reads still withheld from DWL/FR");
    }

    if (driverId && mode === "wallet_summary") {
      if (!periodFrom || !periodTo) {
        return new Response(JSON.stringify({ error: "from and to required for wallet_summary" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const wallet_summary = await fetchDriverWalletSummary(supabase, {
        driverId: String(driverId),
        periodKey,
        periodFrom: String(periodFrom),
        periodTo: String(periodTo),
        serviceAreaId: serviceAreaId ? String(serviceAreaId) : null,
        stripe,
      });
      return new Response(JSON.stringify({ success: true, wallet_summary }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (driverId) {
      const detail = await fetchDriverWalletPayoutSnapshot(supabase, {
        driverId: String(driverId),
        stripe: null,
      });
      return new Response(JSON.stringify({ success: true, driver: detail }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // P0: list drivers with wallet activity OR active payout destination — not stripe_account_id.
    let countQuery = supabase
      .from("drivers")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true);

    if (regionId) countQuery = countQuery.eq("region_id", regionId);

    const { count: totalCount, error: countErr } = await countQuery;
    if (countErr) {
      // Fallback if is_active missing: list all in region without Connect filter.
      let fallbackCount = supabase.from("drivers").select("id", { count: "exact", head: true });
      if (regionId) fallbackCount = fallbackCount.eq("region_id", regionId);
      const fb = await fallbackCount;
      if (fb.error) throw countErr;

      let driversQuery = supabase
        .from("drivers")
        .select("id, driver_code, user_id, region_id")
        .order("driver_code", { ascending: true })
        .range(offset, offset + limit - 1);
      if (regionId) driversQuery = driversQuery.eq("region_id", regionId);
      const { data: drivers, error: driversErr } = await driversQuery;
      if (driversErr) throw driversErr;
      const rows = [];
      for (const d of drivers ?? []) {
        rows.push(await fetchDriverWalletPayoutSnapshot(supabase, {
          driverId: d.id,
          stripe: null,
        }));
      }
      return new Response(JSON.stringify({
        success: true,
        drivers: rows,
        total: fb.count ?? rows.length,
        limit,
        offset,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let driversQuery = supabase
      .from("drivers")
      .select("id, driver_code, user_id, region_id")
      .eq("is_active", true)
      .order("driver_code", { ascending: true })
      .range(offset, offset + limit - 1);

    if (regionId) driversQuery = driversQuery.eq("region_id", regionId);

    const { data: drivers, error: driversErr } = await driversQuery;
    if (driversErr) throw driversErr;

    const rows = [];
    for (const d of drivers ?? []) {
      rows.push(await fetchDriverWalletPayoutSnapshot(supabase, {
        driverId: d.id,
        stripe: null,
      }));
    }

    return new Response(JSON.stringify({
      success: true,
      drivers: rows,
      total: totalCount ?? rows.length,
      limit,
      offset,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[admin-driver-wallet-ssot]", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
