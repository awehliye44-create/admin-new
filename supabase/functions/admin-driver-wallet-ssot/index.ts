/**
 * Admin Driver Wallet SSOT — per-driver snapshot from distinct sources.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { fetchDriverWalletPayoutSnapshot } from "../_shared/fetchDriverWalletPayoutSnapshot.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
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

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const url = new URL(req.url);
    const driverId = body.driver_id ?? url.searchParams.get("driver_id");
    const regionId = body.region_id ?? url.searchParams.get("region_id");

    const stripe = stripeKey ? new Stripe(stripeKey, { apiVersion: "2023-10-16" }) : null;

    if (driverId) {
      const detail = await fetchDriverWalletPayoutSnapshot(supabase, {
        driverId: String(driverId),
        stripe,
      });
      return new Response(JSON.stringify({ success: true, driver: detail }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let driversQuery = supabase
      .from("drivers")
      .select("id, driver_code, user_id, stripe_account_id, region_id")
      .not("stripe_account_id", "is", null)
      .limit(100);

    if (regionId) driversQuery = driversQuery.eq("region_id", regionId);

    const { data: drivers, error: driversErr } = await driversQuery;
    if (driversErr) throw driversErr;

    const rows = [];
    for (const d of drivers ?? []) {
      rows.push(await fetchDriverWalletPayoutSnapshot(supabase, {
        driverId: d.id,
        stripe,
      }));
    }

    return new Response(JSON.stringify({ success: true, drivers: rows }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[admin-driver-wallet-ssot]", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
