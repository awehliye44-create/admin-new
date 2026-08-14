import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { assertEmailChangeAllowed } from "../_shared/emailChangePolicy.ts";
import {
  completeEmailChangeAfterVerify,
  stageEmailChange,
  writeEmailChangedAudit,
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

/**
 * Customer email change — direct apply (no verification link / email OTP).
 * Drivers continue to use send/verify-account-email-change-verification.
 */
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
    const newEmailRaw = String(body.new_email ?? "").trim();

    const service = createClient(supabaseUrl, serviceKey);

    const guard = await assertEmailChangeAllowed(service, user.id, "customer", newEmailRaw);
    if (!guard.ok) {
      return jsonResponse({ error: guard.message, code: guard.code }, guard.httpStatus);
    }

    await repairStaleAuthBeforeContactChange(service, user.id);

    const staged = await stageEmailChange(service, user.id, "customer", guard.normalizedEmail);
    if (!staged.ok) {
      return jsonResponse({ error: staged.message, code: staged.code }, 500);
    }

    const completed = await completeEmailChangeAfterVerify(
      service,
      user.id,
      "customer",
      guard.normalizedEmail,
    );

    if (!completed.ok) {
      return jsonResponse({ error: completed.message, code: completed.code }, 500);
    }

    const now = new Date().toISOString();
    await service
      .from("account_email_change_requests")
      .update({ status: "cancelled", cancelled_at: now })
      .eq("user_id", user.id)
      .eq("account_type", "customer")
      .eq("status", "pending");

    await writeEmailChangedAudit(service, {
      appType: "customer",
      userId: user.id,
      profileId: guard.accountId,
      emailSuffix: guard.normalizedEmail.split("@")[0]?.slice(-4) ?? "****",
    });

    console.info("CUSTOMER_EMAIL_CHANGE_APPLIED", JSON.stringify({
      user_id: user.id,
      email_suffix: guard.normalizedEmail.split("@")[0]?.slice(-4) ?? "****",
    }));

    return jsonResponse({
      ok: true,
      message: "Email updated successfully.",
      email: guard.normalizedEmail,
    });
  } catch (err) {
    console.error("apply-customer-email-change error:", err);
    return jsonResponse({ error: "We couldn't update your email. Please try again." }, 500);
  }
});
