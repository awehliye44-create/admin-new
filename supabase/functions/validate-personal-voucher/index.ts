import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { handleCORSPreflight } from "../_shared/security.ts";
import {
  PERSONAL_VOUCHER_ERROR_MESSAGES,
  resolvePersonalVoucherForTrip,
} from "../_shared/resolve-personal-voucher.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await supabaseAuth.auth.getUser();
    if (userError || !userData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const code = typeof body?.code === "string" ? body.code : "";
    const estimatedFarePence = Math.max(0, Math.floor(Number(body?.estimated_fare_pence) || 0));

    if (!code.trim()) {
      return new Response(JSON.stringify({ error: "Voucher code is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    const { data: customer, error: customerError } = await admin
      .from("customers")
      .select("id")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (customerError || !customer?.id) {
      return new Response(JSON.stringify({ error: "Customer account not found" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await resolvePersonalVoucherForTrip({
      admin,
      code,
      customerId: customer.id,
      estimatedFarePence,
    });

    if (!result.ok) {
      return new Response(
        JSON.stringify({ valid: false, error: PERSONAL_VOUCHER_ERROR_MESSAGES[result.error] }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        valid: true,
        voucher_id: result.resolved.voucherId,
        code: result.resolved.voucherCode,
        discount_pence: result.resolved.discountPence,
        final_fare_pence: result.resolved.finalFarePence,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
