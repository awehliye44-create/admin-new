/**
 * Public password-recovery endpoint.
 * Generates a Supabase Auth recovery link server-side, then emails it via
 * the existing Resend helper (never the default Supabase recovery mailer).
 *
 * POST { email, app: "driver" | "customer" | "corporate" }
 * Always returns a neutral success message (no account enumeration).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { fetchCompanyBranding } from "../_shared/companyBranding.ts";
import {
  buildCorporateRecoveryPageUrlFromSession,
  emailRateLimitFingerprint,
  extractRecoveryActionLink,
  extractRecoveryTokenHash,
  getRecoveryRedirect,
  hasDisallowedClientRedirect,
  isUnknownAccountGenerateLinkError,
  normalizeRecoveryEmail,
  parseRecoveryApp,
  passwordRecoverySafeResponse,
} from "../_shared/passwordRecoverySSOT.ts";
import { ensureCorporateAuthUserForRecovery } from "../_shared/corporatePasswordRecoveryProvision.ts";
import { buildPasswordResetEmail } from "../_shared/passwordResetEmail.ts";
import { sendResendEmail } from "../_shared/resendMail.ts";
import {
  checkRateLimit,
  corsHeaders,
  getClientIP,
  rateLimitResponse,
  securityHeaders,
} from "../_shared/security.ts";

const SAFE = passwordRecoverySafeResponse();

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...securityHeaders, ...corsHeaders },
  });
}

async function generateRecoveryLink(
  // deno-lint-ignore no-explicit-any
  admin: any,
  email: string,
  redirectTo: string,
) {
  return await admin.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo },
  });
}

/**
 * Exchange recovery token_hash for a session so the Corporate SPA can load a
 * recovery session from the URL hash (current live build does not call verifyOtp).
 */
async function exchangeCorporateRecoverySession(
  supabaseUrl: string,
  anonKey: string,
  tokenHash: string,
): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
} | null> {
  const res = await fetch(`${supabaseUrl}/auth/v1/verify`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "recovery", token_hash: tokenHash }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("[password-recovery] corporate token exchange failed", {
      status: res.status,
      message: typeof payload?.msg === "string"
        ? payload.msg
        : typeof payload?.error_description === "string"
        ? payload.error_description
        : typeof payload?.message === "string"
        ? payload.message
        : "unknown",
    });
    return null;
  }
  const access = typeof payload?.access_token === "string" ? payload.access_token : "";
  const refresh = typeof payload?.refresh_token === "string" ? payload.refresh_token : "";
  if (!access || !refresh) return null;
  return {
    access_token: access,
    refresh_token: refresh,
    expires_in: typeof payload?.expires_in === "number" ? payload.expires_in : undefined,
    expires_at: typeof payload?.expires_at === "number" ? payload.expires_at : undefined,
    token_type: typeof payload?.token_type === "string" ? payload.token_type : undefined,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  // Never accept client-supplied redirects.
  if (hasDisallowedClientRedirect(body)) {
    console.warn("[password-recovery] rejected client redirect fields");
    return json({ ok: false, error: "Invalid request" }, 400);
  }

  const app = parseRecoveryApp(body.app);
  if (!app) {
    return json({ ok: false, error: "Invalid app" }, 400);
  }

  const email = normalizeRecoveryEmail(body.email);
  if (!email) {
    return json({ ok: false, error: "Invalid email" }, 400);
  }

  const ip = getClientIP(req);
  const emailFp = emailRateLimitFingerprint(email);
  const rate = checkRateLimit(`pwdrec:${app}:${emailFp}:${ip}`, {
    limit: 5,
    windowMs: 15 * 60 * 1000,
  });
  if (!rate.allowed) {
    return rateLimitResponse(rate.retryAfter ?? 60);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceKey) {
    console.error("[password-recovery] missing service configuration");
    return json({ ok: false, error: "Service unavailable" }, 503);
  }

  const redirectTo = getRecoveryRedirect(app, {
    DRIVER_PASSWORD_RESET_REDIRECT: Deno.env.get("DRIVER_PASSWORD_RESET_REDIRECT") ?? undefined,
    CUSTOMER_PASSWORD_RESET_REDIRECT: Deno.env.get("CUSTOMER_PASSWORD_RESET_REDIRECT") ??
      undefined,
    CORPORATE_PASSWORD_RESET_REDIRECT: Deno.env.get("CORPORATE_PASSWORD_RESET_REDIRECT") ??
      undefined,
  });

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("[password-recovery]", JSON.stringify({
    step: "generate_link",
    app,
    emailDomain: email.split("@")[1] ?? "",
    emailFp,
    redirectScheme: redirectTo.split("://")[0] ?? "",
  }));

  let { data: linkData, error: linkError } = await generateRecoveryLink(admin, email, redirectTo);

  if (linkError && app === "corporate" && isUnknownAccountGenerateLinkError(linkError.message)) {
    console.log("[password-recovery]", JSON.stringify({
      step: "corporate_unknown_auth_user",
      emailDomain: email.split("@")[1] ?? "",
    }));
    const ensured = await ensureCorporateAuthUserForRecovery(admin, email);
    if (ensured.ok) {
      console.log("[password-recovery]", JSON.stringify({
        step: "corporate_auth_ensured",
        created: ensured.created,
        emailDomain: email.split("@")[1] ?? "",
      }));
      ({ data: linkData, error: linkError } = await generateRecoveryLink(admin, email, redirectTo));
    } else {
      console.log("[password-recovery]", JSON.stringify({
        step: "corporate_not_provisioned",
        reason: ensured.reason,
        emailDomain: email.split("@")[1] ?? "",
      }));
      return json(SAFE);
    }
  }

  if (linkError) {
    if (isUnknownAccountGenerateLinkError(linkError.message)) {
      console.log("[password-recovery]", JSON.stringify({
        step: "unknown_or_ineligible_account",
        app,
        emailDomain: email.split("@")[1] ?? "",
      }));
      return json(SAFE);
    }
    console.error("[password-recovery] generateLink failed", {
      app,
      message: linkError.message,
    });
    return json(SAFE);
  }

  let recoveryUrl: string | null = null;
  if (app === "corporate") {
    const tokenHash = extractRecoveryTokenHash(linkData);
    if (!tokenHash || !anonKey) {
      console.error("[password-recovery] corporate missing token_hash or anon key");
      return json({ ok: false, error: "Unable to send reset email right now" }, 502);
    }
    const session = await exchangeCorporateRecoverySession(supabaseUrl, anonKey, tokenHash);
    if (!session) {
      return json({ ok: false, error: "Unable to send reset email right now" }, 502);
    }
    recoveryUrl = buildCorporateRecoveryPageUrlFromSession({
      portalResetUrl: redirectTo,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresIn: session.expires_in,
      expiresAt: session.expires_at,
      tokenType: session.token_type,
    });
    console.log("[password-recovery]", JSON.stringify({
      step: "corporate_session_link_built",
      emailDomain: email.split("@")[1] ?? "",
      hasHashSession: Boolean(recoveryUrl?.includes("#access_token=")),
    }));
  } else {
    recoveryUrl = extractRecoveryActionLink(linkData);
  }

  if (!recoveryUrl) {
    console.error("[password-recovery] generateLink missing recovery url fields", { app });
    return json({ ok: false, error: "Unable to send reset email right now" }, 502);
  }

  let logoUrl = "";
  try {
    const branding = await fetchCompanyBranding(admin);
    logoUrl = branding.branding.logoUrl?.trim() || "";
  } catch (e) {
    console.warn("[password-recovery] branding fetch failed", {
      message: e instanceof Error ? e.message : "unknown",
    });
  }

  let rendered: { subject: string; html: string; text: string };
  try {
    rendered = buildPasswordResetEmail({
      recoveryUrl,
      app,
      logoUrl: logoUrl || undefined,
    });
  } catch (e) {
    console.error("[password-recovery] template build failed", {
      message: e instanceof Error ? e.message : "unknown",
    });
    return json({ ok: false, error: "Unable to send reset email right now" }, 502);
  }

  const sent = await sendResendEmail({
    to: email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    replyTo: false,
    tag: "password_recovery",
  });

  if (!sent.ok) {
    console.error("[password-recovery] resend failed", {
      app,
      message: sent.message,
    });
    return json({ ok: false, error: "Unable to send reset email right now" }, 502);
  }

  console.log("[password-recovery]", JSON.stringify({
    step: "email_sent",
    app,
    emailDomain: email.split("@")[1] ?? "",
    provider: "resend",
    providerMessageId: sent.id ?? null,
  }));

  return json(SAFE);
});
