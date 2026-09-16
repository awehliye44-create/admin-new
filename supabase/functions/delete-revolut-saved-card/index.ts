/**
 * delete-revolut-saved-card — Customer JWT → deactivate owned Revolut vault row.
 *
 * Ownership: only the authenticated user's token row may be removed.
 * Does not mutate Payment Sessions / trip payment history.
 * Self-contained (no _shared imports) — same pattern as list-revolut-saved-cards.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const jsonHeaders: Record<string, string> = {
  ...corsHeaders,
  "Content-Type": "application/json",
};

function errorJson(code: string, status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: code, code, message, deleted: false }),
    { status, headers: jsonHeaders },
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      return errorJson("AUTH_MISSING", 401, "Please sign in again to continue.");
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser(auth.replace("Bearer ", ""));
    if (authErr || !user) {
      return errorJson("AUTH_INVALID", 401, "Please sign in again to continue.");
    }

    const body = await req.json().catch(() => ({})) as {
      platform_payment_method_id?: string;
      payment_method_id?: string;
    };
    const platformPaymentMethodId = String(
      body.platform_payment_method_id ?? body.payment_method_id ?? "",
    ).trim();
    if (!platformPaymentMethodId) {
      return errorJson(
        "MISSING_PAYMENT_METHOD_ID",
        400,
        "platform_payment_method_id is required.",
      );
    }

    const { data: existing, error: lookupErr } = await supabase
      .from("customer_saved_payment_method_tokens")
      .select("id, provider_payment_method_id, tokenization_status")
      .eq("user_id", user.id)
      .eq("platform_payment_method_id", platformPaymentMethodId)
      .eq("payment_provider", "revolut")
      .maybeSingle();

    if (lookupErr) {
      console.error("[delete-revolut-saved-card] lookup", lookupErr.message);
      return errorJson("DB_ERROR", 500, "Unable to remove card. Please try again.");
    }

    if (!existing?.id) {
      // Idempotent — already gone / not owned.
      console.log(JSON.stringify({
        fn: "delete-revolut-saved-card",
        event: "payment_method.delete_not_found",
        user_suffix: user.id.length > 8 ? user.id.slice(-8) : user.id,
        platform_pm_suffix: platformPaymentMethodId.length > 8
          ? platformPaymentMethodId.slice(-8)
          : platformPaymentMethodId,
      }));
      return new Response(JSON.stringify({ success: true, deleted: true }), {
        status: 200,
        headers: jsonHeaders,
      });
    }

    // Customer "Remove" must hide the card from the Payment Methods sheet.
    // tokenization_failed is reserved for verification failures (shown with Remove).
    // removed = customer dismissed the method — excluded from usable + unusable lists.
    const now = new Date().toISOString();
    const { error: updateErr } = await supabase
      .from("customer_saved_payment_method_tokens")
      .update({
        tokenization_status: "removed",
        revolut_verified: false,
        updated_at: now,
      })
      .eq("id", existing.id)
      .eq("user_id", user.id);

    if (updateErr) {
      console.error("[delete-revolut-saved-card] update", updateErr.message);
      return errorJson("DB_ERROR", 500, "Unable to remove card. Please try again.");
    }

    console.log(JSON.stringify({
      fn: "delete-revolut-saved-card",
      event: "payment_method.deleted",
      user_suffix: user.id.length > 8 ? user.id.slice(-8) : user.id,
      platform_pm_suffix: platformPaymentMethodId.length > 8
        ? platformPaymentMethodId.slice(-8)
        : platformPaymentMethodId,
      provider_pm_suffix: String(existing.provider_payment_method_id ?? "").length > 8
        ? String(existing.provider_payment_method_id).slice(-8)
        : existing.provider_payment_method_id ?? null,
    }));

    return new Response(JSON.stringify({ success: true, deleted: true }), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (err) {
    console.error(
      "[delete-revolut-saved-card]",
      err instanceof Error ? err.message : "unknown",
    );
    return errorJson("INTERNAL", 500, "Unable to remove card. Please try again.");
  }
});
