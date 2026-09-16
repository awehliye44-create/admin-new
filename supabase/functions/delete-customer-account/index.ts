import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Authenticate the requesting user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await anonClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = user.id;

    // Use service role client for deletions
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // 1. Find customer record(s) for this user
    const { data: customers } = await adminClient
      .from("customers")
      .select("id")
      .eq("user_id", userId);

    const customerIds = (customers || []).map((c: { id: string }) => c.id);

    if (customerIds.length > 0) {
      // 2. Delete dependent records in order to avoid FK violations
      // customer_wallet_ledger depends on customer_wallets
      const { data: wallets } = await adminClient
        .from("customer_wallets")
        .select("id")
        .in("customer_id", customerIds);

      const walletIds = (wallets || []).map((w: { id: string }) => w.id);

      if (walletIds.length > 0) {
        await adminClient
          .from("customer_wallet_ledger")
          .delete()
          .in("wallet_id", walletIds);
      }

      // Delete wallets
      await adminClient
        .from("customer_wallets")
        .delete()
        .in("customer_id", customerIds);

      // Delete call masking sessions
      await adminClient
        .from("call_masking_sessions")
        .delete()
        .in("customer_id", customerIds);

      // Delete support conversations
      await adminClient
        .from("support_conversations")
        .delete()
        .in("customer_id", customerIds);

      // Delete passenger ratings
      await adminClient
        .from("passenger_ratings")
        .delete()
        .in("passenger_id", customerIds);

      // 3. Delete customer push tokens (keyed by user_id)
      await adminClient
        .from("customer_push_tokens")
        .delete()
        .eq("user_id", userId);

      // 4. Delete the customer records themselves
      await adminClient
        .from("customers")
        .delete()
        .eq("user_id", userId);
    }

    // 5. Decide whether to delete the auth user.
    // Rule: keep auth alive if the SAME user_id still has any other role
    // (currently: a driver row). Only when this was the user's last
    // remaining role do we hard-delete the Supabase Auth user so login stops working.
    const { data: drivers, error: driverLookupError } = await adminClient
      .from("drivers")
      .select("id")
      .eq("user_id", userId)
      .limit(1);

    if (driverLookupError) {
      console.error("Failed to check for existing driver role:", driverLookupError);
      return new Response(
        JSON.stringify({ error: "Customer data deleted but role check failed. Contact support." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const stillHasDriverRole = (drivers?.length ?? 0) > 0;

    if (stillHasDriverRole) {
      console.log(
        `[delete-customer-account] Customer rows removed for user ${userId}, ` +
        `but driver role still exists — preserving auth user.`
      );
      return new Response(
        JSON.stringify({
          success: true,
          authDeleted: false,
          message: "Customer profile deleted. Driver account preserved.",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // No other role remains — delete the auth user so old login stops working.
    const { error: deleteAuthError } = await adminClient.auth.admin.deleteUser(userId);
    if (deleteAuthError) {
      console.error("Failed to delete auth user:", deleteAuthError);
      return new Response(
        JSON.stringify({ error: "Account data deleted but auth removal failed. Contact support." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        authDeleted: true,
        message: "Account permanently deleted",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("delete-customer-account error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
