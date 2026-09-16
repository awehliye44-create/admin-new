import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  isAccountEmailVerified,
  type OnboardingAppType,
} from "../_shared/onboardingLoginGuard.ts";
import { nativeAppCorsHeaders as corsHeaders } from "../_shared/security.ts";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function logEvent(event: string, payload: Record<string, unknown>) {
  console.log(event, JSON.stringify(payload));
}

async function establishUnverifiedSession(
  supabaseUrl: string,
  anonKey: string,
  serviceKey: string,
  email: string,
  password: string,
  userId: string,
) {
  const anon = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const service = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: passwordSession, error: passwordSessionError } = await anon.auth.signInWithPassword({
    email,
    password,
  });

  if (!passwordSessionError && passwordSession.session) {
    return passwordSession;
  }

  const { data: linkData, error: linkError } = await service.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError || !linkData?.properties?.hashed_token) {
    console.error("resume-verification-sign-in generateLink error:", linkError);
    return null;
  }

  const { data: otpSession, error: otpSessionError } = await anon.auth.verifyOtp({
    type: "magiclink",
    token_hash: linkData.properties.hashed_token,
  });
  if (otpSessionError || !otpSession.session) {
    console.error("resume-verification-sign-in verifyOtp error:", otpSessionError);
    return null;
  }

  const { error: resetErr } = await service.rpc("reset_auth_user_email_unconfirmed", {
    _user_id: userId,
  });
  if (resetErr) {
    console.error("resume-verification-sign-in reset email unconfirmed error:", resetErr);
  }

  return otpSession;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const body = await req.json().catch(() => ({}));
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const appType: OnboardingAppType = body.app_type === "driver" ? "driver" : "customer";

    if (!email || !email.includes("@") || password.length < 8) {
      return jsonResponse({ error: "Invalid email or password." }, 400);
    }

    const service = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const anon = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: signInProbe, error: signInProbeError } = await anon.auth.signInWithPassword({
      email,
      password,
    });

    if (signInProbeError && !/invalid login credentials|email not confirmed|email not verified/i.test(signInProbeError.message)) {
      return jsonResponse({ error: "Incorrect email or password." }, 401);
    }

    const userId = signInProbe.user?.id;
    if (!userId) {
      return jsonResponse({ error: "Incorrect email or password." }, 401);
    }

    const { data: authLookup } = await service.auth.admin.getUserById(userId);
    const authUser = authLookup?.user;
    if (!authUser) {
      return jsonResponse({ error: "Incorrect email or password." }, 401);
    }

    const emailVerified = await isAccountEmailVerified(
      service,
      userId,
      appType,
      authUser.email_confirmed_at,
    );

    if (emailVerified) {
      return jsonResponse({
        error: "Your email is already verified. Please sign in normally.",
        code: "email_already_verified",
      }, 409);
    }

    const sessionData = signInProbe.session
      ? signInProbe
      : await establishUnverifiedSession(supabaseUrl, anonKey, serviceKey, email, password, userId);

    if (!sessionData?.session) {
      return jsonResponse({ error: "Could not continue verification. Please try again." }, 500);
    }

    logEvent("RESUME_VERIFICATION_SIGN_IN", {
      user_id: userId,
      app_type: appType,
      email,
    });

    return jsonResponse({
      ok: true,
      session: {
        access_token: sessionData.session.access_token,
        refresh_token: sessionData.session.refresh_token,
        expires_in: sessionData.session.expires_in,
        expires_at: sessionData.session.expires_at,
      },
      user_id: userId,
    });
  } catch (err) {
    console.error("resume-verification-sign-in error:", err);
    return jsonResponse({ error: "Could not continue verification. Please try again." }, 500);
  }
});
