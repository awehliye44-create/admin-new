import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";
import {
  evaluateCustomerOnboardingLogin,
  logOnboardingLoginBlock,
  type OnboardingLoginGuardResult,
} from "../_shared/onboardingLoginGuard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function toValidationResponse(guard: OnboardingLoginGuardResult) {
  if (guard.app_access_allowed) {
    return {
      valid: true,
      reason: "active" as const,
      email_verified: true,
      phone_verified: true,
    };
  }

  const reason = guard.block_code === "NO_PROFILE" ? "no_profile" : "pending_verification";
  return {
    valid: false,
    reason,
    message: guard.message ?? "Please complete verification to continue.",
    email_verified: guard.email_verified,
    phone_verified: guard.phone_verified,
  };
}

serveWithEdgeTiming("validate-customer", corsHeaders, async (req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ valid: false, reason: "no_session", message: "No authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await anonClient.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ valid: false, reason: "invalid_session", message: "Session is invalid or expired" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    // SSOT — admin suspension/restriction MUST be checked BEFORE the onboarding guard.
    // evaluateCustomerOnboardingLogin returns pending_verification when pending_phone_change
    // is non-null. If the account is ALSO admin-suspended, the guard fires first and
    // AccountCompletionGate shows "Verification Required" instead of "Account Blocked".
    // Spec AT #10: blocked screen only for true admin suspension/restriction.
    const { data: customer, error: custError } = await serviceClient
      .from("customers")
      .select("id, first_name, last_name, phone, rider_status, deleted_at, updated_at, email_verified, phone_verified")
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (custError) {
      console.error("Customer lookup error:", custError);
      return new Response(
        JSON.stringify({ valid: false, reason: "server_error", message: "Failed to look up customer" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Deleted account — skip all other checks.
    if (customer?.deleted_at) {
      return new Response(
        JSON.stringify({ valid: false, reason: "deleted", message: "Your account has been deleted. Please contact support." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Admin suspension check — takes priority over any pending verification state.
    const { data: suspension } = await serviceClient
      .from("account_suspensions")
      .select("id, reason, status, expires_at")
      .eq("user_id", user.id)
      .eq("user_type", "customer")
      .eq("status", "active")
      .order("suspended_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (suspension && !(suspension.expires_at && new Date(suspension.expires_at) < new Date())) {
      return new Response(
        JSON.stringify({
          valid: false,
          reason: "suspended",
          message: suspension.reason || "Your account has been suspended. Please contact support.",
          expires_at: suspension.expires_at,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Rider-status block (disabled/banned/blocked) — also takes priority.
    const blockedStatuses = ["disabled", "suspended", "banned", "blocked"];
    if (customer && blockedStatuses.includes(customer.rider_status?.toLowerCase())) {
      return new Response(
        JSON.stringify({
          valid: false,
          reason: "account_disabled",
          message: `Your account is ${customer.rider_status}. Please contact support.`,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Now run the full onboarding/verification guard (handles pending_phone_change,
    // email/phone verified state, onboarding completion, etc.)
    const guard = await evaluateCustomerOnboardingLogin(serviceClient, user.id);

    if (!guard.app_access_allowed) {
      const payload = toValidationResponse(guard);
      if (guard.block_code && guard.message) {
        await logOnboardingLoginBlock(serviceClient, {
          user_id: user.id,
          app_type: "customer",
          block_code: guard.block_code,
          message: guard.message,
          intent: "session_check",
        });
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!customer) {
      return new Response(
        JSON.stringify({
          valid: false,
          reason: "no_profile",
          message: "Complete verification to activate your account.",
          email_verified: true,
          phone_verified: true,
          customer: null,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        valid: true,
        reason: "active",
        customer: {
          id: customer.id,
          first_name: customer.first_name,
          last_name: customer.last_name,
          rider_status: customer.rider_status,
        },
        email_verified: true,
        phone_verified: true,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("validate-customer error:", err);
    return new Response(
      JSON.stringify({ valid: false, reason: "server_error", message: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
