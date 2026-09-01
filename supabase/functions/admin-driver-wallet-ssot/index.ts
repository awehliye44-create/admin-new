/**
 * Admin Driver Wallet SSOT — per-driver snapshot from distinct sources.
 * Drivers listed without provider_account_id filter.
 * PIPELINE 1 only: PLATFORM_COLLECTED service-area membership.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { fetchDriverWalletPayoutSnapshot } from "../_shared/fetchDriverWalletPayoutSnapshot.ts";
import { fetchDriverWalletSummary } from "../_shared/fetchDriverWalletSummary.ts";
import { FINANCIAL_MODEL, resolveServiceAreaFinancialScope } from "../_shared/financialModelScopeGate.ts";
import { resolvePlatformCollectedDriverIds } from "../_shared/platformCollectedDriverScope.ts";

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

    // PIPELINE 1 isolation — Driver Wallet Ledger is PLATFORM_COLLECTED only.
    const modelScope = await resolveServiceAreaFinancialScope(
      supabase,
      FINANCIAL_MODEL.PLATFORM_COLLECTED,
      serviceAreaId ?? null,
    );
    if (!modelScope.ok) {
      return new Response(JSON.stringify({ error: modelScope.error, error_code: modelScope.code }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const platformDriverIds = await resolvePlatformCollectedDriverIds(supabase, {
      service_area_id: serviceAreaId ? String(serviceAreaId) : null,
      allowed_service_area_ids: modelScope.allowedServiceAreaIds,
    });
    const platformDriverIdSet = new Set(platformDriverIds);

    const limit = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Number(body.limit ?? url.searchParams.get("limit") ?? DEFAULT_PAGE_SIZE)),
    );
    const offset = Math.max(0, Number(body.offset ?? url.searchParams.get("offset") ?? 0));

    if (driverId && mode === "wallet_summary") {
      if (!periodFrom || !periodTo) {
        return new Response(JSON.stringify({ error: "from and to required for wallet_summary" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!platformDriverIdSet.has(String(driverId))) {
        return new Response(JSON.stringify({
          error: "Driver is outside PLATFORM_COLLECTED Driver Wallet scope",
          error_code: "FINANCIAL_MODEL_VIOLATION",
        }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const wallet_summary = await fetchDriverWalletSummary(supabase, {
        driverId: String(driverId),
        periodKey,
        periodFrom: String(periodFrom),
        periodTo: String(periodTo),
        serviceAreaId: serviceAreaId ? String(serviceAreaId) : null,
      });
      return new Response(JSON.stringify({ success: true, wallet_summary }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (driverId) {
      if (!platformDriverIdSet.has(String(driverId))) {
        return new Response(JSON.stringify({
          error: "Driver is outside PLATFORM_COLLECTED Driver Wallet scope",
          error_code: "FINANCIAL_MODEL_VIOLATION",
        }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const detail = await fetchDriverWalletPayoutSnapshot(supabase, {
        driverId: String(driverId),
        ...(periodFrom && periodTo ? { periodFrom: String(periodFrom), periodTo: String(periodTo) } : {}),
      });
      return new Response(JSON.stringify({ success: true, driver: detail }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (platformDriverIds.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        drivers: [],
        total: 0,
        limit,
        offset,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // P0: list drivers with wallet activity OR active payout destination — PLATFORM SA membership only.
    let countQuery = supabase
      .from("drivers")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .in("id", platformDriverIds);

    if (regionId) countQuery = countQuery.eq("region_id", regionId);

    const { count: totalCount, error: countErr } = await countQuery;
    if (countErr) {
      let fallbackCount = supabase
        .from("drivers")
        .select("id", { count: "exact", head: true })
        .in("id", platformDriverIds);
      if (regionId) fallbackCount = fallbackCount.eq("region_id", regionId);
      const fb = await fallbackCount;
      if (fb.error) throw countErr;

      let driversQuery = supabase
        .from("drivers")
        .select("id, driver_code, user_id, region_id")
        .in("id", platformDriverIds)
        .order("driver_code", { ascending: true })
        .range(offset, offset + limit - 1);
      if (regionId) driversQuery = driversQuery.eq("region_id", regionId);
      const { data: drivers, error: driversErr } = await driversQuery;
      if (driversErr) throw driversErr;
      const rows = [];
      for (const d of drivers ?? []) {
        rows.push(await fetchDriverWalletPayoutSnapshot(supabase, {
          driverId: d.id,
          ...(periodFrom && periodTo ? { periodFrom: String(periodFrom), periodTo: String(periodTo) } : {}),
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
      .in("id", platformDriverIds)
      .order("driver_code", { ascending: true })
      .range(offset, offset + limit - 1);

    if (regionId) driversQuery = driversQuery.eq("region_id", regionId);

    const { data: drivers, error: driversErr } = await driversQuery;
    if (driversErr) throw driversErr;

    const rows = [];
    for (const d of drivers ?? []) {
      rows.push(await fetchDriverWalletPayoutSnapshot(supabase, {
        driverId: d.id,
        ...(periodFrom && periodTo ? { periodFrom: String(periodFrom), periodTo: String(periodTo) } : {}),
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
