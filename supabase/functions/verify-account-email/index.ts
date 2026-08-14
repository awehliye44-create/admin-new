import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { resolveVerificationAppType } from "../_shared/accountEmailVerification.ts";
import {
  assertNativeClientOnly,
  EMAIL_VERIFICATION_AUDIT,
  hashVerificationToken,
  isLatestUnusedVerificationToken,
  isVerificationTokenExpired,
  logVerificationAudit,
} from "../_shared/emailVerificationPolicy.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version, x-onecab-native-client",
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const nativeGuard = assertNativeClientOnly(req);
    if (nativeGuard) return nativeGuard;

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const service = createClient(supabaseUrl, serviceKey);

    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const token = String(body.token ?? url.searchParams.get("token") ?? "").trim();
    const appType = resolveVerificationAppType(body.app_type ?? url.searchParams.get("app"));

    if (!token) {
      logVerificationAudit(EMAIL_VERIFICATION_AUDIT.INVALID_TOKEN, { app_type: appType, reason: "missing_token" });
      return jsonResponse({
        ok: false,
        code: "invalid_token",
        error: "This verification link is invalid.",
      }, 400);
    }

    const hash = await hashVerificationToken(token);
    const { data: row, error } = await service
      .from("account_email_verifications")
      .select("id, user_id, email, expires_at, verified_at")
      .eq("token_hash", hash)
      .eq("app_type", appType)
      .maybeSingle();

    if (error || !row) {
      logVerificationAudit(EMAIL_VERIFICATION_AUDIT.INVALID_TOKEN, {
        app_type: appType,
        reason: "token_not_found",
      });
      return jsonResponse({
        ok: false,
        code: "invalid_token",
        error: "This verification link is invalid.",
      }, 400);
    }

    const { data: authLookup } = await service.auth.admin.getUserById(row.user_id);
    if (authLookup?.user?.email_confirmed_at) {
      logVerificationAudit(EMAIL_VERIFICATION_AUDIT.ALREADY_VERIFIED, {
        user_id: row.user_id,
        email: row.email,
        app_type: appType,
      });
      return jsonResponse({ ok: true, already_verified: true });
    }

    if (row.verified_at) {
      logVerificationAudit(EMAIL_VERIFICATION_AUDIT.ALREADY_VERIFIED, {
        user_id: row.user_id,
        email: row.email,
        app_type: appType,
        source: "token_row",
      });
      return jsonResponse({ ok: true, already_verified: true });
    }

    if (isVerificationTokenExpired(row.expires_at)) {
      logVerificationAudit(EMAIL_VERIFICATION_AUDIT.EXPIRED, {
        user_id: row.user_id,
        email: row.email,
        app_type: appType,
        expires_at: row.expires_at,
      });
      return jsonResponse({
        ok: false,
        code: "expired_token",
        error: "This verification link has expired.",
      }, 400);
    }

    if (!(await isLatestUnusedVerificationToken(service, row, appType))) {
      logVerificationAudit(EMAIL_VERIFICATION_AUDIT.INVALID_TOKEN, {
        user_id: row.user_id,
        email: row.email,
        app_type: appType,
        reason: "superseded_token",
      });
      return jsonResponse({
        ok: false,
        code: "invalid_token",
        error: "This verification link is invalid.",
      }, 400);
    }

    const now = new Date().toISOString();
    await service.from("account_email_verifications").update({ verified_at: now }).eq("id", row.id);
    await service
      .from("account_email_verifications")
      .delete()
      .eq("user_id", row.user_id)
      .eq("app_type", appType)
      .is("verified_at", null)
      .neq("id", row.id);

    await service.auth.admin.updateUserById(row.user_id, { email_confirm: true });
    await service.rpc("mark_account_email_verified", { _user_id: row.user_id, _app_type: appType });

    logVerificationAudit(EMAIL_VERIFICATION_AUDIT.SUCCESS, {
      user_id: row.user_id,
      email: row.email,
      app_type: appType,
    });

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("verify-account-email error:", err);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
