import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");

    if (!stripeSecretKey) {
      return new Response(
        JSON.stringify({ error: "Stripe not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify admin
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check admin role
    const { data: roleData } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();

    if (!roleData) {
      return new Response(
        JSON.stringify({ error: "Admin access required" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { driver_id } = await req.json();

    if (!driver_id) {
      return new Response(
        JSON.stringify({ error: "driver_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get driver
    const { data: driver, error: driverError } = await supabase
      .from("drivers")
      .select("id, email, first_name, last_name, stripe_account_id")
      .eq("id", driver_id)
      .single();

    if (driverError || !driver) {
      return new Response(
        JSON.stringify({ error: "Driver not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let stripeAccountId = driver.stripe_account_id;

    // Create Stripe Connect account if not exists
    if (!stripeAccountId) {
      const createRes = await fetch("https://api.stripe.com/v1/accounts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          type: "express",
          country: "GB",
          email: driver.email,
          "capabilities[transfers][requested]": "true",
          "business_type": "individual",
          "individual[first_name]": driver.first_name || "",
          "individual[last_name]": driver.last_name || "",
        }),
      });

      const account = await createRes.json();
      if (account.error) {
        console.error("[stripe-onboard] Create account error:", account.error);
        return new Response(
          JSON.stringify({ error: account.error.message }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      stripeAccountId = account.id;

      // Save to driver record
      await supabase
        .from("drivers")
        .update({ stripe_account_id: stripeAccountId })
        .eq("id", driver_id);
    }

    // Create onboarding link
    const linkRes = await fetch("https://api.stripe.com/v1/account_links", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        account: stripeAccountId!,
        refresh_url: `${supabaseUrl}/functions/v1/stripe-onboard-driver?refresh=true`,
        return_url: `${supabaseUrl}/functions/v1/stripe-onboard-driver?success=true`,
        type: "account_onboarding",
      }),
    });

    const link = await linkRes.json();
    if (link.error) {
      console.error("[stripe-onboard] Link error:", link.error);
      return new Response(
        JSON.stringify({ error: link.error.message }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[stripe-onboard] Generated onboarding link for driver ${driver_id}`);

    return new Response(
      JSON.stringify({ 
        url: link.url, 
        stripe_account_id: stripeAccountId 
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[stripe-onboard] Error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
