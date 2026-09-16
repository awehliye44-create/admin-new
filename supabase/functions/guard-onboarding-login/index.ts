import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  evaluateCustomerOnboardingLogin,
  evaluateDriverOnboardingLogin,
  logOnboardingLoginBlock,
  ONBOARDING_LOGIN_BLOCK,
  shouldRevokeSessionOnBlock,
  type OnboardingAppType,
  type OnboardingLoginIntent,
} from "../_shared/onboardingLoginGuard.ts";
import { getVerificationState } from "../_shared/verificationState.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version, x-onecab-native-client",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anon = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const service = createClient(supabaseUrl, serviceKey);

    const { data: { user }, error: userError } = await anon.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const appType: OnboardingAppType = body.app_type === "driver" ? "driver" : "customer";
    const rawIntent = typeof body.intent === "string" ? body.intent : "sign_in";
    const intent: OnboardingLoginIntent =
      rawIntent === "continue_verification" || rawIntent === "session_check"
        ? rawIntent
        : "sign_in";

    const result = appType === "driver"
      ? await evaluateDriverOnboardingLogin(service, user.id)
      : await evaluateCustomerOnboardingLogin(service, user.id);

    let sessionRevoked = false;
    if (!result.app_access_allowed && result.block_code && result.message) {
      await logOnboardingLoginBlock(service, {
        user_id: user.id,
        app_type: appType,
        block_code: result.block_code,
        message: result.message,
        intent,
      });
      console.info("ONBOARDING_LOGIN_BLOCKED", JSON.stringify({
        user_id: user.id,
        app_type: appType,
        intent,
        block_code: result.block_code,
      }));

      // Never revoke the session for a pending phone *change*: the user is already an active
      // account holder who started a change flow. Revoking here causes a login loop —
      // every sign_in attempt is blocked and revoked until the 30-min pending TTL expires.
      // Session revocation remains correct for initial-onboarding blocks (PHONE_NOT_VERIFIED,
      // EMAIL_NOT_VERIFIED, etc.) where the account was never fully activated.
      const isPhoneChangePending = result.block_code === ONBOARDING_LOGIN_BLOCK.PHONE_CHANGE_PENDING;
      if (shouldRevokeSessionOnBlock(intent) && !isPhoneChangePending) {
        const { error: signOutError } = await service.auth.admin.signOut(user.id, "global");
        sessionRevoked = !signOutError;
        if (signOutError) {
          console.warn("ONBOARDING_LOGIN_SESSION_REVOKE_FAILED", JSON.stringify({
            user_id: user.id,
            error: signOutError.message,
          }));
        } else {
          console.info("ONBOARDING_LOGIN_SESSION_REVOKED", JSON.stringify({
            user_id: user.id,
            app_type: appType,
            block_code: result.block_code,
          }));
        }
      }
    }

    const verificationState = await getVerificationState(service, user.id, appType);

    const payload = {
      ok: result.app_access_allowed,
      ...result,
      verification_state: verificationState,
      session_revoked: sessionRevoked,
    };

    if (!result.app_access_allowed && intent === "sign_in") {
      return new Response(JSON.stringify(payload), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("guard-onboarding-login error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
