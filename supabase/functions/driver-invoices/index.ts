import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error("Unauthorized");

    // Get the driver record for this user
    const { data: driver, error: driverError } = await supabase
      .from("drivers")
      .select("id, region_id")
      .eq("user_id", user.id)
      .single();

    if (driverError || !driver) throw new Error("Driver not found");

    const url = new URL(req.url);
    const invoiceId = url.searchParams.get("invoice_id");

    if (invoiceId) {
      // Get single invoice with items — only if it belongs to this driver
      const { data: invoice, error: invError } = await supabase
        .from("invoices")
        .select("*, regions(name, currency_code, distance_unit), service_areas(name), invoice_items(*)")
        .eq("id", invoiceId)
        .eq("driver_id", driver.id)
        .in("status", ["sent", "viewed", "finalized"])
        .single();

      if (invError || !invoice) throw new Error("Invoice not found");

      // Mark as viewed if first time
      if (invoice.status === "sent") {
        await supabase
          .from("invoices")
          .update({ status: "viewed", viewed_at: new Date().toISOString() })
          .eq("id", invoiceId);
      }

      // Currency comes from Region — the SSOT
      const regionCurrency = invoice.regions?.currency_code || invoice.currency_code;
      const distanceUnit = invoice.regions?.distance_unit || "mile";

      return new Response(JSON.stringify({
        success: true,
        invoice: {
          ...invoice,
          resolved_currency_code: regionCurrency,
          resolved_distance_unit: distanceUnit,
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // List invoices for this driver — only sent/viewed/finalized
    const { data: invoices, error: listError } = await supabase
      .from("invoices")
      .select("id, invoice_number, period_start, period_end, currency_code, net_earnings_pence, completed_trips, status, created_at, region_id, regions(name, currency_code)")
      .eq("driver_id", driver.id)
      .in("status", ["sent", "viewed", "finalized"])
      .order("period_end", { ascending: false })
      .limit(50);

    if (listError) throw listError;

    // Ensure each invoice returns the region's currency (SSOT)
    const enriched = (invoices || []).map((inv: any) => ({
      ...inv,
      resolved_currency_code: inv.regions?.currency_code || inv.currency_code,
    }));

    return new Response(JSON.stringify({ success: true, invoices: enriched }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
