import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getDriverStatementSignedUrl } from "../_shared/deliverDriverStatement.ts";

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
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: { user }, error: authError } = await supabaseUser.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: driver, error: driverError } = await supabaseUser
      .from("drivers")
      .select("id")
      .eq("user_id", user.id)
      .single();

    if (driverError || !driver) {
      return new Response(JSON.stringify({ error: "Driver not found" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = req.method === "GET"
      ? Object.fromEntries(new URL(req.url).searchParams)
      : await req.json();

    const invoiceId = body.invoice_id;
    if (!invoiceId) {
      return new Response(JSON.stringify({ error: "invoice_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { signed_url, pdf_unavailable, invoice } = await getDriverStatementSignedUrl(
      supabaseAdmin,
      invoiceId,
      driver.id,
    );

    return new Response(JSON.stringify({
      success: !pdf_unavailable,
      signed_url,
      pdf_unavailable,
      invoice: {
        id: invoice.id,
        invoice_number: invoice.invoice_number,
        period_start: invoice.period_start,
        period_end: invoice.period_end,
        net_earnings_pence: invoice.net_earnings_pence,
        completed_trips: invoice.completed_trips,
        status: invoice.status,
        currency_code: invoice.regions?.currency_code || invoice.currency_code,
        gross_earnings_pence: invoice.gross_earnings_pence,
        commission_pence: invoice.commission_pence,
        bonuses_pence: invoice.bonuses_pence,
        penalties_pence: invoice.penalties_pence,
        adjustments_pence: invoice.adjustments_pence,
        cash_collected_pence: invoice.cash_collected_pence,
      },
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[driver-statement-pdf] Error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
