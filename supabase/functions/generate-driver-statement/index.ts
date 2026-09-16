import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { formatPenceWithCurrency, formatPenceSigned } from "../_shared/currency.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * generate-driver-statement
 *
 * Admin-only edge function that generates a monthly statement for a driver
 * from the driver_wallet_ledger (single financial source of truth).
 *
 * Statements are generated PER REGION — a multi-region driver gets separate statements.
 *
 * Input: { driver_id, region_id, year, month }
 * - OR -
 * Bulk: { region_id, year, month } → generates for ALL drivers in that region
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Verify admin role
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check admin role
    const { data: roleData } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();

    if (!roleData) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { driver_id, region_id, year, month } = body;

    if (!region_id || !year || !month) {
      return new Response(
        JSON.stringify({ error: "region_id, year, and month are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Get region info (currency is single source of truth)
    const { data: region, error: regionError } = await supabaseAdmin
      .from("regions")
      .select("id, name, currency_code, distance_unit")
      .eq("id", region_id)
      .single();

    if (regionError || !region) {
      return new Response(
        JSON.stringify({ error: "Region not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const currencyCode = region.currency_code;
    if (!currencyCode) {
      return new Response(
        JSON.stringify({ error: "Region has no currency_code configured" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Calculate period boundaries
    const periodStart = `${year}-${String(month).padStart(2, "0")}-01`;
    const periodEndDate = new Date(year, month, 0); // last day of month
    const periodEnd = `${year}-${String(month).padStart(2, "0")}-${String(periodEndDate.getDate()).padStart(2, "0")}`;

    const periodStartTs = `${periodStart}T00:00:00.000Z`;
    const periodEndTs = `${periodEnd}T23:59:59.999Z`;

    // Get drivers to process
    let driverIds: string[] = [];
    if (driver_id) {
      driverIds = [driver_id];
    } else {
      // Bulk: all drivers in this region
      const { data: drivers } = await supabaseAdmin
        .from("drivers")
        .select("id")
        .eq("region_id", region_id);
      driverIds = (drivers || []).map((d: any) => d.id);
    }

    console.log(`[generate-driver-statement] Processing ${driverIds.length} drivers for ${region.name} ${year}-${month}`);

    const results: any[] = [];

    for (const did of driverIds) {
      // Get driver info
      const { data: driver } = await supabaseAdmin
        .from("drivers")
        .select("id, first_name, last_name, driver_code, service_area_id")
        .eq("id", did)
        .single();

      if (!driver) continue;

      // Query ledger for this driver in this period
      const { data: ledgerEntries, error: ledgerError } = await supabaseAdmin
        .from("driver_wallet_ledger")
        .select("id, amount_pence, type, description, related_trip_id, created_at")
        .eq("driver_id", did)
        .gte("created_at", periodStartTs)
        .lte("created_at", periodEndTs)
        .order("created_at", { ascending: true });

      if (ledgerError) {
        console.error(`[generate-driver-statement] Ledger error for driver ${did}:`, ledgerError);
        continue;
      }

      const entries = ledgerEntries || [];

      // Aggregate from ledger (single source of truth)
      let grossEarningsPence = 0;
      let commissionPence = 0;
      let netEarningsPence = 0;
      let tipsPence = 0;
      let payoutsPence = 0;
      let adjustmentsPence = 0;
      let totalTrips = 0;

      const lineItems: any[] = [];

      for (const entry of entries) {
        const e = entry as any;
        lineItems.push({
          date: e.created_at,
          type: e.type,
          description: e.description || e.type,
          amount_pence: e.amount_pence,
          formatted_amount: formatPenceSigned(e.amount_pence, currencyCode),
          trip_id: e.related_trip_id,
        });

        switch (e.type) {
          case "TRIP_EARNING_NET":
          case "DRIVER_CARD_CREDIT":
            netEarningsPence += e.amount_pence;
            totalTrips += 1;
            break;
          case "PLATFORM_COMMISSION":
            commissionPence += Math.abs(e.amount_pence);
            break;
          case "DRIVER_TIP_CREDIT":
            tipsPence += e.amount_pence;
            break;
          case "PAYOUT":
            payoutsPence += Math.abs(e.amount_pence);
            break;
          default:
            adjustmentsPence += e.amount_pence;
            break;
        }
      }

      // Also count card net earnings toward gross
      grossEarningsPence += netEarningsPence + commissionPence;

      // Skip if no activity
      if (entries.length === 0) {
        results.push({ driver_id: did, status: "skipped", reason: "no_activity" });
        continue;
      }

      // Build statement_data JSON
      const statementData = {
        driver_name: `${driver.first_name} ${driver.last_name}`,
        driver_code: driver.driver_code,
        region_name: region.name,
        currency_code: currencyCode,
        distance_unit: region.distance_unit,
        period_label: `${new Date(year, month - 1).toLocaleString("en", { month: "long" })} ${year}`,
        summary: {
          total_trips: totalTrips,
          gross_earnings: formatPenceWithCurrency(grossEarningsPence, currencyCode),
          commission: formatPenceWithCurrency(commissionPence, currencyCode),
          net_earnings: formatPenceWithCurrency(netEarningsPence, currencyCode),
          tips: formatPenceWithCurrency(tipsPence, currencyCode),
          payouts: formatPenceWithCurrency(payoutsPence, currencyCode),
        },
        line_items: lineItems,
        generated_at: new Date().toISOString(),
        generated_by_user_id: user.id,
      };

      // Upsert statement (idempotent per driver+region+period)
      const { error: upsertError } = await supabaseAdmin
        .from("driver_statements")
        .upsert(
          {
            driver_id: did,
            region_id: region_id,
            service_area_id: driver.service_area_id || null,
            period_start: periodStart,
            period_end: periodEnd,
            currency_code: currencyCode,
            total_trips: totalTrips,
            gross_earnings_pence: grossEarningsPence,
            commission_pence: commissionPence,
            net_earnings_pence: netEarningsPence,
            tips_pence: tipsPence,
            payouts_pence: payoutsPence,
            adjustments_pence: adjustmentsPence,
            statement_data: statementData,
            status: "generated",
            generated_at: new Date().toISOString(),
            generated_by: user.id,
          },
          { onConflict: "driver_id,region_id,period_start" },
        );

      if (upsertError) {
        console.error(`[generate-driver-statement] Upsert error for driver ${did}:`, upsertError);
        results.push({ driver_id: did, status: "error", error: upsertError.message });
      } else {
        results.push({ driver_id: did, status: "generated", total_trips: totalTrips });
      }
    }

    console.log(`[generate-driver-statement] Complete: ${results.filter(r => r.status === "generated").length} generated, ${results.filter(r => r.status === "skipped").length} skipped`);

    return new Response(
      JSON.stringify({
        success: true,
        region: region.name,
        currency_code: currencyCode,
        period: `${year}-${String(month).padStart(2, "0")}`,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[generate-driver-statement] Error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
