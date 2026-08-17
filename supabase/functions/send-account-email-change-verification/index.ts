import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  resolveVerificationAppType,
  type VerificationAppType,
} from "../_shared/accountEmailVerification.ts";
import {
  assertEmailChangeAllowed,
  assertEmailChangeResendAllowed,
  type EmailChangeAccountType,
} from "../_shared/emailChangePolicy.ts";
import {
  createEmailChangeRequest,
  prepareEmailChangeToken,
  resolveEmailChangeFirstName,
  sendEmailChangeVerification,
  stageEmailChange,
} from "../_shared/emailChangeSsot.ts";
import { repairStaleAuthBeforeContactChange } from "../_shared/phoneChangeSsot.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function resolveAccountType(appType: VerificationAppType): EmailChangeAccountType {
  return appType === "driver" ? "driver" : "customer";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);
    }

    const anon = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await anon.auth.getUser();
    if (userError || !user) {
      return jsonResponse({ error: "Please sign in again.", code: "INVALID_SESSION" }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const appType = resolveVerificationAppType(body.account_type);
    const accountType = resolveAccountType(appType);
    const newEmailRaw = String(body.new_email ?? "").trim();

    const service = createClient(supabaseUrl, serviceKey);

    await repairStaleAuthBeforeContactChange(service, user.id);

    const guard = await assertEmailChangeAllowed(service, user.id, accountType, newEmailRaw);
    if (!guard.ok) {
      return jsonResponse({ error: guard.message, code: guard.code }, guard.httpStatus);
    }

    const rateLimit = await assertEmailChangeResendAllowed(service, user.id, appType);
    if (!rateLimit.ok) {
      return jsonResponse({
        error: `Please wait ${rateLimit.retryAfterSeconds} seconds before requesting another verification email.`,
        code: "RATE_LIMITED",
        retry_after_seconds: rateLimit.retryAfterSeconds,
      }, 429);
    }

    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const userAgent = req.headers.get("user-agent");

    const firstName = await resolveEmailChangeFirstName(
      service,
      user.id,
      accountType,
      user.user_metadata,
    );

    // SSOT: generate token FIRST, send email SECOND, persist DB row THIRD.
    // This ensures the 60s resend cooldown and stage row are never written for emails
    // that were never delivered, preventing false RATE_LIMITED errors on retry.
    const tokenPrep = await prepareEmailChangeToken();

    const sent = await sendEmailChangeVerification({
      service,
      supabaseUrl,
      appType,
      toEmail: guard.normalizedEmail,
      firstName,
      rawToken: tokenPrep.rawToken,
    });

    if (!sent.ok) {
      return jsonResponse({
        error: "We couldn't send the verification email. Please try again.",
        code: "EMAIL_SEND_FAILED",
      }, 500);
    }

    // Email delivered — now stage and persist the pending change in our DB.
    const staged = await stageEmailChange(service, user.id, accountType, guard.normalizedEmail);
    if (!staged.ok) {
      // Stage failed after email was sent — log for ops, still return success.
      // User will receive the email and can verify. Rate limiter won't block them.
      console.warn("ACCOUNT_EMAIL_CHANGE_STAGE_FAILED_AFTER_SEND", JSON.stringify({
        user_id: user.id,
        code: staged.code,
        message: staged.message,
      }));
    }

    const requestRow = await createEmailChangeRequest(service, {
      userId: user.id,
      accountType,
      accountId: guard.accountId,
      currentEmail: guard.currentEmail,
      newEmail: guard.normalizedEmail,
      createdIp: clientIp,
      userAgent,
      preGenerated: tokenPrep,
    });

    if (!requestRow.ok) {
      // Row insert failed after email was sent — log for ops, still return success.
      console.warn("ACCOUNT_EMAIL_CHANGE_ROW_FAILED_AFTER_SEND", JSON.stringify({
        user_id: user.id,
        message: requestRow.message,
      }));
    }

    console.info("ACCOUNT_EMAIL_CHANGE_SENT", JSON.stringify({
      user_id: user.id,
      account_type: accountType,
      email_suffix: guard.normalizedEmail.split("@")[0]?.slice(-4) ?? "****",
      expires_at: tokenPrep.expiresAt,
      resend_id: sent.resendId ?? null,
    }));

    return jsonResponse({
      ok: true,
      message: "Check your new email to confirm the change.",
    });
  } catch (err) {
    console.error("send-account-email-change-verification error:", err);
    return jsonResponse({ error: "We couldn't send the verification email. Please try again." }, 500);
  }
});
