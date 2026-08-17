import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  nativeAppHandoffLocation,
  resolveVerificationAppType,
  type VerificationAppType,
} from "../_shared/accountEmailVerification.ts";
import {
  EMAIL_VERIFICATION_AUDIT,
  hashVerificationToken,
  isLatestUnusedVerificationToken,
  isVerificationTokenExpired,
  logVerificationAudit,
} from "../_shared/emailVerificationPolicy.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: {
      ...corsHeaders,
      Location: location,
      "Cache-Control": "no-store",
    },
  });
}

function nativeAppHandoffResponse(
  req: Request,
  appType: VerificationAppType,
  token: string,
  error?: string,
): Response {
  return redirectResponse(nativeAppHandoffLocation({
    appType,
    path: "auth/verify-email",
    token,
    error,
    userAgent: req.headers.get("user-agent"),
  }));
}

type LinkValidation =
  | { ok: true }
  | { ok: false; reason: "missing_token" | "invalid_token" | "expired_token" | "already_verified" };

async function validateVerificationLink(
  token: string,
  appType: VerificationAppType,
): Promise<LinkValidation> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return { ok: false, reason: "invalid_token" };
  }

  const service = createClient(supabaseUrl, serviceKey);
  const hash = await hashVerificationToken(token);
  const { data: row, error } = await service
    .from("account_email_verifications")
    .select("id, user_id, expires_at, verified_at")
    .eq("token_hash", hash)
    .eq("app_type", appType)
    .maybeSingle();

  if (error || !row) {
    return { ok: false, reason: "invalid_token" };
  }

  const { data: authLookup } = await service.auth.admin.getUserById(row.user_id);
  if (authLookup?.user?.email_confirmed_at || row.verified_at) {
    return { ok: false, reason: "already_verified" };
  }

  if (isVerificationTokenExpired(row.expires_at)) {
    return { ok: false, reason: "expired_token" };
  }

  if (!(await isLatestUnusedVerificationToken(service, row, appType))) {
    return { ok: false, reason: "invalid_token" };
  }

  return { ok: true };
}

const NON_RECOVERABLE_LINK_REASONS = new Set([
  "missing_token",
  "invalid_token",
  "expired_token",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const token = String(url.searchParams.get("token") ?? "").trim();
  const appType = resolveVerificationAppType(url.searchParams.get("app"));

  if (!token) {
    logVerificationAudit(EMAIL_VERIFICATION_AUDIT.INVALID_TOKEN, {
      app_type: appType,
      phase: "verify_link",
      reason: "missing_token",
    });
    return nativeAppHandoffResponse(req, appType, "", "missing_token");
  }

  const validation = await validateVerificationLink(token, appType);
  if (!validation.ok) {
    const auditEvent = validation.reason === "expired_token"
      ? EMAIL_VERIFICATION_AUDIT.EXPIRED
      : validation.reason === "already_verified"
      ? EMAIL_VERIFICATION_AUDIT.ALREADY_VERIFIED
      : EMAIL_VERIFICATION_AUDIT.INVALID_TOKEN;
    logVerificationAudit(auditEvent, {
      app_type: appType,
      phase: "verify_link",
      reason: validation.reason,
    });
    const openToken = NON_RECOVERABLE_LINK_REASONS.has(validation.reason) ? "" : token;
    return nativeAppHandoffResponse(req, appType, openToken, validation.reason);
  }

  return nativeAppHandoffResponse(req, appType, token);
});
