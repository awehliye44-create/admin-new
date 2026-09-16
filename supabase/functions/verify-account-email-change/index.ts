import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { resolveVerificationAppType } from "../_shared/accountEmailVerification.ts";
import {
  findPendingEmailChangeRequest,
  isLatestPendingEmailChangeRequest,
} from "../_shared/emailChangePolicy.ts";
import {
  completeEmailChangeAfterVerify,
  writeEmailChangedAudit,
} from "../_shared/emailChangeSsot.ts";
import { isVerificationTokenExpired } from "../_shared/emailVerificationPolicy.ts";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const service = createClient(supabaseUrl, serviceKey);

    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const token = String(body.token ?? url.searchParams.get("token") ?? "").trim();
    const appType = resolveVerificationAppType(body.account_type ?? url.searchParams.get("app"));

    if (!token) {
      return jsonResponse({
        ok: false,
        code: "invalid_token",
        error: "This verification link is invalid.",
      }, 400);
    }

    const row = await findPendingEmailChangeRequest(service, token, appType === "driver" ? "driver" : "customer");
    if (!row) {
      return jsonResponse({
        ok: false,
        code: "invalid_token",
        error: "This verification link is invalid.",
      }, 400);
    }

    if (row.status === "verified" || row.verified_at) {
      return jsonResponse({
        ok: false,
        code: "already_used",
        error: "Verification link already used.",
      }, 400);
    }

    if (row.status !== "pending") {
      return jsonResponse({
        ok: false,
        code: "invalid_token",
        error: "This verification link is invalid.",
      }, 400);
    }

    if (isVerificationTokenExpired(row.expires_at)) {
      await service
        .from("account_email_change_requests")
        .update({ status: "expired" })
        .eq("id", row.id);

      return jsonResponse({
        ok: false,
        code: "expired_token",
        error: "Verification link expired.",
      }, 400);
    }

    if (!(await isLatestPendingEmailChangeRequest(service, row))) {
      return jsonResponse({
        ok: false,
        code: "invalid_token",
        error: "This verification link is invalid.",
      }, 400);
    }

    const completed = await completeEmailChangeAfterVerify(
      service,
      row.user_id,
      row.account_type,
      row.new_email,
    );

    if (!completed.ok) {
      await service
        .from("account_email_change_requests")
        .update({ status: "failed" })
        .eq("id", row.id);

      return jsonResponse({ ok: false, error: completed.message, code: completed.code }, 500);
    }

    const now = new Date().toISOString();
    await service
      .from("account_email_change_requests")
      .update({ status: "verified", verified_at: now })
      .eq("id", row.id);

    await service
      .from("account_email_change_requests")
      .update({ status: "cancelled", cancelled_at: now })
      .eq("user_id", row.user_id)
      .eq("account_type", row.account_type)
      .eq("status", "pending")
      .neq("id", row.id);

    await writeEmailChangedAudit(service, {
      appType: row.account_type,
      userId: row.user_id,
      profileId: row.account_id,
      emailSuffix: row.new_email.split("@")[0]?.slice(-4) ?? "****",
    });

    console.info("ACCOUNT_EMAIL_CHANGE_VERIFIED", JSON.stringify({
      user_id: row.user_id,
      account_type: row.account_type,
    }));

    return jsonResponse({ ok: true, message: "Email updated successfully." });
  } catch (err) {
    console.error("verify-account-email-change error:", err);
    return jsonResponse({ error: "Verification failed. Please try again." }, 500);
  }
});
