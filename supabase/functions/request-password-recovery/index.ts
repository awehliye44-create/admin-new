/**
 * Public password-recovery endpoint.
 * Generates a Supabase Auth recovery link server-side, then emails it via
 * the existing Resend helper (never the default Supabase recovery mailer).
 *
 * POST { email, app: "driver" | "customer" }
 * Always returns a neutral success message (no account enumeration).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { fetchCompanyBranding } from "../_shared/companyBranding.ts";
import {
  emailRateLimitFingerprint,
  extractRecoveryActionLink,
  getRecoveryRedirect,
  hasDisallowedClientRedirect,
  isUnknownAccountGenerateLinkError,
  normalizeRecoveryEmail,
  parseRecoveryApp,
  passwordRecoverySafeResponse,
} from "../_shared/passwordRecoverySSOT.ts";
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
    // Same outer shape as success where appropriate — still 429 for abuse.
    return rateLimitResponse(rate.retryAfter ?? 60);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    console.error("[password-recovery] missing service configuration");
    return json({ ok: false, error: "Service unavailable" }, 503);
  }

  const redirectTo = getRecoveryRedirect(app, {
    DRIVER_PASSWORD_RESET_REDIRECT: Deno.env.get("DRIVER_PASSWORD_RESET_REDIRECT") ?? undefined,
    CUSTOMER_PASSWORD_RESET_REDIRECT: Deno.env.get("CUSTOMER_PASSWORD_RESET_REDIRECT") ??
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
    // never log redirect with tokens — redirect scheme only
    redirectScheme: redirectTo.split("://")[0] ?? "",
  }));

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo },
  });

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
    // Do not reveal account existence via Admin error text.
    return json(SAFE);
  }

  const recoveryUrl = extractRecoveryActionLink(linkData);
  if (!recoveryUrl) {
    console.error("[password-recovery] generateLink missing action_link", { app });
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
    // never log recoveryUrl / tokens
  }));

  return json(SAFE);
});
