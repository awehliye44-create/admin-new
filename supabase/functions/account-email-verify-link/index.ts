import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  accountEmailVerifiedPageUrl,
  resolveVerificationAppType,
  type VerificationAppType,
} from "../_shared/accountEmailVerification.ts";
import {
  consumeAccountEmailVerificationToken,
  EMAIL_VERIFICATION_AUDIT,
  logVerificationAudit,
  type ConsumeEmailVerificationResult,
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

function handoffPage(
  appType: VerificationAppType,
  status: Parameters<typeof accountEmailVerifiedPageUrl>[1],
): Response {
  // Always 302 to static Pages HTML. Supabase Edge forces function HTML bodies to
  // Content-Type: text/plain (CSP sandbox), which makes Safari show raw source.
  return redirectResponse(accountEmailVerifiedPageUrl(appType, status));
}

function statusFromConsume(result: ConsumeEmailVerificationResult): Parameters<
  typeof accountEmailVerifiedPageUrl
>[1] {
  if (result.ok) {
    return result.alreadyVerified ? "already_verified" : "ok";
  }
  return result.code;
}

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
    return handoffPage(appType, "missing_token");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    logVerificationAudit(EMAIL_VERIFICATION_AUDIT.INVALID_TOKEN, {
      app_type: appType,
      phase: "verify_link",
      reason: "misconfigured",
    });
    return handoffPage(appType, "error");
  }

  try {
    const service = createClient(supabaseUrl, serviceKey);
    // Confirm Auth BEFORE browser→app handoff so “I’ve confirmed” works even if
    // the custom-scheme open is blocked.
    const consumed = await consumeAccountEmailVerificationToken(service, token, appType);
    const status = statusFromConsume(consumed);

    if (consumed.ok) {
      logVerificationAudit(
        consumed.alreadyVerified
          ? EMAIL_VERIFICATION_AUDIT.ALREADY_VERIFIED
          : EMAIL_VERIFICATION_AUDIT.SUCCESS,
        {
          user_id: consumed.userId,
          app_type: appType,
          phase: "verify_link",
        },
      );
    } else {
      const auditEvent = consumed.code === "expired_token"
        ? EMAIL_VERIFICATION_AUDIT.EXPIRED
        : EMAIL_VERIFICATION_AUDIT.INVALID_TOKEN;
      logVerificationAudit(auditEvent, {
        app_type: appType,
        phase: "verify_link",
        reason: consumed.code,
      });
    }

    return handoffPage(appType, status);
  } catch (err) {
    console.error("account-email-verify-link error:", err instanceof Error ? err.message : "error");
    return handoffPage(appType, "error");
  }
});
