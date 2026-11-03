import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { resolveVerificationAppType } from "../_shared/accountEmailVerification.ts";
import {
  assertNativeClientOnly,
  consumeAccountEmailVerificationToken,
  EMAIL_VERIFICATION_AUDIT,
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
      logVerificationAudit(EMAIL_VERIFICATION_AUDIT.INVALID_TOKEN, {
        app_type: appType,
        reason: "missing_token",
      });
      return jsonResponse({
        ok: false,
        code: "invalid_token",
        error: "This verification link is invalid.",
      }, 400);
    }

    const consumed = await consumeAccountEmailVerificationToken(service, token, appType);
    if (!consumed.ok) {
      const auditEvent = consumed.code === "expired_token"
        ? EMAIL_VERIFICATION_AUDIT.EXPIRED
        : EMAIL_VERIFICATION_AUDIT.INVALID_TOKEN;
      logVerificationAudit(auditEvent, {
        app_type: appType,
        reason: consumed.code,
      });
      return jsonResponse({
        ok: false,
        code: consumed.code,
        error: consumed.code === "expired_token"
          ? "This verification link has expired."
          : "This verification link is invalid.",
      }, 400);
    }

    logVerificationAudit(
      consumed.alreadyVerified
        ? EMAIL_VERIFICATION_AUDIT.ALREADY_VERIFIED
        : EMAIL_VERIFICATION_AUDIT.SUCCESS,
      {
        user_id: consumed.userId,
        app_type: appType,
      },
    );

    return jsonResponse({
      ok: true,
      ...(consumed.alreadyVerified ? { already_verified: true } : {}),
    });
  } catch (err) {
    console.error("verify-account-email error:", err);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
