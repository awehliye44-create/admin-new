/**
 * change-customer-email — Customer JWT → immediate Auth email swap (no verification).
 *
 * Sets the new address as the official sign-in email and confirms it server-side
 * so the previous email no longer authenticates this account.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version, x-onecab-native-client",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonHeaders: Record<string, string> = {
  ...corsHeaders,
  "Content-Type": "application/json",
};

function errorJson(code: string, status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: code, code, message }), {
    status,
    headers: jsonHeaders,
  });
}

function successJson(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    status: 200,
    headers: jsonHeaders,
  });
}

function normalizeEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function isValidEmail(email: string): boolean {
  // Practical RFC-lite check — reject obviously invalid values.
  if (email.length < 5 || email.length > 254) return false;
  if (!email.includes("@")) return false;
  const [local, domain] = email.split("@");
  if (!local || !domain || domain.indexOf(".") < 1) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return errorJson("METHOD_NOT_ALLOWED", 405, "Use POST.");
  }

  try {
    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      return errorJson("AUTH_MISSING", 401, "Please sign in again to continue.");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return errorJson("NOT_CONFIGURED", 500, "Email change is temporarily unavailable.");
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const {
      data: { user },
      error: authErr,
    } = await admin.auth.getUser(auth.replace("Bearer ", ""));
    if (authErr || !user) {
      return errorJson("AUTH_INVALID", 401, "Please sign in again to continue.");
    }

    let body: Record<string, unknown> = {};
    try {
      const parsed = await req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      return errorJson("INVALID_BODY", 400, "Invalid request body.");
    }

    const nextEmail = normalizeEmail(body.new_email ?? body.email);
    if (!isValidEmail(nextEmail)) {
      return errorJson("INVALID_EMAIL", 400, "Enter a valid email address.");
    }

    const currentEmail = normalizeEmail(user.email);
    if (currentEmail && currentEmail === nextEmail) {
      return errorJson(
        "EMAIL_UNCHANGED",
        400,
        "That is already your signed-in email.",
      );
    }

    // Ensure the customer owns a customers row (do not invent profile data).
    const { data: customer, error: customerErr } = await admin
      .from("customers")
      .select("id, user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (customerErr) {
      console.error("[change-customer-email] customers lookup", customerErr.message);
      return errorJson("DB_ERROR", 500, "Unable to update email. Please try again.");
    }
    if (!customer?.id) {
      return errorJson(
        "CUSTOMER_NOT_FOUND",
        404,
        "Complete registration before changing your email.",
      );
    }

    const { data: updated, error: updateErr } = await admin.auth.admin.updateUserById(
      user.id,
      {
        email: nextEmail,
        email_confirm: true,
      },
    );

    if (updateErr) {
      const msg = updateErr.message?.toLowerCase() ?? "";
      if (
        msg.includes("already") ||
        msg.includes("registered") ||
        msg.includes("exists") ||
        msg.includes("duplicate")
      ) {
        return errorJson(
          "EMAIL_IN_USE",
          409,
          "That email is already used by another account.",
        );
      }
      console.error("[change-customer-email] admin update", updateErr.message);
      return errorJson("UPDATE_FAILED", 500, "Unable to update email. Please try again.");
    }

    const confirmedEmail = normalizeEmail(updated.user?.email) || nextEmail;

    // Mark customer email verified to match Auth (no verification gate for customers).
    const { error: verifyErr } = await admin
      .from("customers")
      .update({ email_verified: true })
      .eq("id", customer.id)
      .eq("user_id", user.id);

    if (verifyErr) {
      // Auth email already swapped — log but do not fail the request.
      console.error("[change-customer-email] customers.email_verified", verifyErr.message);
    }

    console.log(
      JSON.stringify({
        fn: "change-customer-email",
        user_id: user.id,
        customer_id: customer.id,
        previous_email_present: Boolean(currentEmail),
        ok: true,
      }),
    );

    return successJson({
      email: confirmedEmail,
      message: "Your sign-in email was updated.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.error("[change-customer-email] unhandled", message);
    return errorJson("INTERNAL", 500, "Unable to update email. Please try again.");
  }
});
