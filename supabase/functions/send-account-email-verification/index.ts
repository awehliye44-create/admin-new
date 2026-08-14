import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  accountEmailVerificationBridgeUrl,
  accountEmailVerificationWebUrl,
  resolveVerificationAppBaseUrl,
  resolveVerificationAppType,
  type VerificationAppType,
} from "../_shared/accountEmailVerification.ts";
import {
  assertPendingVerificationAccountForEmailSend,
  assertVerificationResendAllowed,
  EMAIL_VERIFICATION_AUDIT,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS,
  generateVerificationToken,
  hashVerificationToken,
  invalidateUnusedVerificationTokens,
  logVerificationAudit,
  ONECAB_NATIVE_CLIENT_HEADER,
  verificationExpiresAt,
} from "../_shared/emailVerificationPolicy.ts";
import {
  renderVerificationEmail,
  resolveVerificationFirstName,
} from "../_shared/emailVerificationTemplate.ts";
import { sendResendEmail } from "../_shared/resendMail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version, x-onecab-native-client",
};

function assertNativeClientOnly(req: Request): Response | null {
  const nativeClient = String(req.headers.get(ONECAB_NATIVE_CLIENT_HEADER) ?? "").trim().toLowerCase();
  if (nativeClient !== "native") {
    logVerificationAudit(EMAIL_VERIFICATION_AUDIT.SENT, {
      phase: "send_blocked",
      reason: "browser_client_not_allowed",
    });
    return new Response(JSON.stringify({
      error: "Verification emails can only be sent from the ONECAB app.",
      code: "native_app_required",
    }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return null;
}

async function resolveProfileFirstName(
  service: ReturnType<typeof createClient>,
  userId: string,
  appType: VerificationAppType,
): Promise<string | null> {
  if (appType === "admin") {
    const { data } = await service
      .from("profiles")
      .select("full_name")
      .eq("user_id", userId)
      .maybeSingle();
    const fullName = typeof data?.full_name === "string" ? data.full_name.trim() : "";
    return fullName.split(/\s+/)[0] || null;
  }

  if (appType === "customer") {
    const { data: pending } = await service
      .from("pending_customer_signups")
      .select("first_name")
      .eq("user_id", userId)
      .maybeSingle();
    if (typeof pending?.first_name === "string") {
      return pending.first_name;
    }
  }

  const table = appType === "driver" ? "drivers" : "customers";
  const { data } = await service
    .from(table)
    .select("first_name")
    .eq("user_id", userId)
    .maybeSingle();

  return typeof data?.first_name === "string" ? data.first_name : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const nativeGuard = assertNativeClientOnly(req);
    if (nativeGuard) return nativeGuard;

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
    const { data: { user }, error: userError } = await anon.auth.getUser();
    if (userError || !user?.email) {
      return new Response(JSON.stringify({ error: "Invalid session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const appType = resolveVerificationAppType(body.app_type);

    if (user.email_confirmed_at) {
      logVerificationAudit(EMAIL_VERIFICATION_AUDIT.ALREADY_VERIFIED, {
        user_id: user.id,
        email: user.email,
        app_type: appType,
        phase: "send_blocked",
      });
      return new Response(JSON.stringify({ ok: true, already_verified: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const isResend = body.resend === true;
    const redirectBase = resolveVerificationAppBaseUrl(appType, {
      customerAppUrl: Deno.env.get("CUSTOMER_APP_URL"),
      driverAppUrl: Deno.env.get("DRIVER_APP_URL"),
      adminAppUrl: Deno.env.get("ADMIN_APP_URL"),
      appUrl: Deno.env.get("APP_URL"),
    });

    const service = createClient(supabaseUrl, serviceKey);

    const pendingAccount = await assertPendingVerificationAccountForEmailSend(service, user.id, appType);
    if (!pendingAccount.ok) {
      logVerificationAudit(EMAIL_VERIFICATION_AUDIT.SENT, {
        user_id: user.id,
        email: user.email,
        app_type: appType,
        phase: "send_blocked",
        reason: pendingAccount.code,
      });
      return new Response(JSON.stringify({
        error: pendingAccount.message,
        code: pendingAccount.code,
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rateLimit = await assertVerificationResendAllowed(service, user.id, appType);
    if (!rateLimit.ok) {
      return new Response(JSON.stringify({
        error: `Please wait ${rateLimit.retryAfterSeconds} seconds before requesting another verification email.`,
        retry_after_seconds: rateLimit.retryAfterSeconds,
        code: "rate_limited",
      }), {
        status: 429,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Retry-After": String(rateLimit.retryAfterSeconds),
        },
      });
    }

    await invalidateUnusedVerificationTokens(service, user.id, appType);

    const rawToken = generateVerificationToken();
    const hash = await hashVerificationToken(rawToken);
    const expiresAt = verificationExpiresAt();

    const { error: insertError } = await service.from("account_email_verifications").insert({
      user_id: user.id,
      email: user.email,
      app_type: appType,
      token_hash: hash,
      expires_at: expiresAt,
    });
    if (insertError) throw insertError;

    const webVerifyUrl = accountEmailVerificationWebUrl(redirectBase, appType, rawToken);
    const verifyUrl = accountEmailVerificationBridgeUrl(supabaseUrl, appType, rawToken);
    const profileFirstName = await resolveProfileFirstName(service, user.id, appType);
    const firstName = resolveVerificationFirstName(user.user_metadata, profileFirstName);

    const emailContent = renderVerificationEmail({
      appType: appType === "admin" ? "customer" : appType,
      firstName,
      verifyUrl,
      webVerifyUrl,
    });

    const sent = await sendResendEmail({
      to: user.email,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
    });

    if (!sent.ok) {
      logVerificationAudit(isResend ? EMAIL_VERIFICATION_AUDIT.RESENT : EMAIL_VERIFICATION_AUDIT.SENT, {
        user_id: user.id,
        email: user.email,
        app_type: appType,
        outcome: "failed",
        reason: sent.message,
      });
      return new Response(JSON.stringify({ error: sent.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logVerificationAudit(
      isResend ? EMAIL_VERIFICATION_AUDIT.RESENT : EMAIL_VERIFICATION_AUDIT.SENT,
      {
        user_id: user.id,
        email: user.email,
        app_type: appType,
        resend_id: sent.id ?? null,
        expires_at: expiresAt,
        cooldown_seconds: EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS,
      },
    );

    return new Response(JSON.stringify({ ok: true, resend_id: sent.id ?? null }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("send-account-email-verification error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
