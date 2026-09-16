/**
 * Customer-only: when Auth still has email_confirmed_at null (legacy accounts),
 * verify password then permanently confirm email and return a session.
 * Phone OTP remains the only onboarding verification step.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { nativeAppCorsHeaders as corsHeaders } from "../_shared/security.ts";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isEmailNotConfirmedAuthError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("email not confirmed") ||
    normalized.includes("email not verified") ||
    normalized.includes("email_not_confirmed")
  );
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

    if (!email || !email.includes("@") || password.length < 8) {
      return jsonResponse({ error: "Invalid email or password." }, 400);
    }

    const anon = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const service = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: probe, error: probeError } = await anon.auth.signInWithPassword({
      email,
      password,
    });

    if (!probeError && probe.session) {
      return jsonResponse({
        ok: true,
        already_confirmed: true,
        session: {
          access_token: probe.session.access_token,
          refresh_token: probe.session.refresh_token,
          expires_in: probe.session.expires_in,
          expires_at: probe.session.expires_at,
        },
        user_id: probe.user?.id ?? null,
      });
    }

    const probeMessage = probeError?.message ?? "";
    if (/invalid login credentials|invalid email or password/i.test(probeMessage)) {
      return jsonResponse({ error: "Incorrect email or password." }, 401);
    }
    if (!isEmailNotConfirmedAuthError(probeMessage)) {
      return jsonResponse({ error: "Incorrect email or password." }, 401);
    }

    const { data: userId, error: lookupErr } = await service.rpc("get_user_id_by_email", {
      p_email: email,
    });
    if (lookupErr || !userId) {
      console.error("customer-login-confirm-email lookup error:", lookupErr);
      return jsonResponse({ error: "Incorrect email or password." }, 401);
    }

    const { error: confirmErr } = await service.auth.admin.updateUserById(String(userId), {
      email_confirm: true,
    });
    if (confirmErr) {
      console.error("customer-login-confirm-email confirm error:", confirmErr);
      return jsonResponse({ error: "Could not continue sign-in. Please try again." }, 500);
    }

    await service
      .from("customers")
      .update({
        email_verified: true,
        email_verified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .is("deleted_at", null);

    try {
      await service
        .from("pending_customer_signups")
        .update({ status: "email_verified", updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("status", "pending");
    } catch {
      // Best-effort — column/schema differences must not block login.
    }

    const { data: signedIn, error: signInError } = await anon.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError || !signedIn.session) {
      console.error("customer-login-confirm-email post-confirm sign-in error:", signInError);
      return jsonResponse({ error: "Could not continue sign-in. Please try again." }, 500);
    }

    console.log(
      "CUSTOMER_LOGIN_EMAIL_CONFIRMED",
      JSON.stringify({ user_id: userId, email }),
    );

    return jsonResponse({
      ok: true,
      already_confirmed: false,
      session: {
        access_token: signedIn.session.access_token,
        refresh_token: signedIn.session.refresh_token,
        expires_in: signedIn.session.expires_in,
        expires_at: signedIn.session.expires_at,
      },
      user_id: userId,
    });
  } catch (err) {
    console.error("customer-login-confirm-email error:", err);
    return jsonResponse({ error: "Could not continue sign-in. Please try again." }, 500);
  }
});
