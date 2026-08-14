/**
 * list-revolut-saved-cards — Customer JWT → saved card rows for the wallet sheet.
 *
 * Self-contained (no _shared imports). Prior BOOT_ERROR 503 was caused by
 * importing missing symbols / a circular paymentMethodSSOT graph from _shared.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const REVOLUT_SAVE_CARD_TOKENIZATION_READY = true;

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
    JSON.stringify({ error: code, code, message }),
    { status, headers: jsonHeaders },
  );
}

function successResponse(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ success: true, ...data }), {
    status: 200,
    headers: jsonHeaders,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!REVOLUT_SAVE_CARD_TOKENIZATION_READY) {
      return successResponse({ cards: [], ready: false });
    }

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

    // Booking confirm writes tokenization_status=verified (+ revolut_verified).
    // Standalone setup-revolut-card writes tokenization_status=active.
    // Failed tokens are returned separately so the sheet can explain why a card
    // is missing — never hide a verification failure with an empty list only.
    const { data, error } = await supabase
      .from("customer_saved_payment_method_tokens")
      .select(
        "platform_payment_method_id, brand, last4, exp_month, exp_year, provider_payment_method_id, created_at, tokenization_status, revolut_verified",
      )
      .eq("user_id", user.id)
      .eq("payment_provider", "revolut")
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[list-revolut-saved-cards]", error.message);
      return errorJson("DB_ERROR", 500, "Unable to load saved cards. Please try again.");
    }

    const rows = data ?? [];
    const cards = rows
      .filter((row) => {
        const status = String(row.tokenization_status ?? "");
        if (status === "tokenization_failed") return false;
        const hasRef = Boolean(String(row.provider_payment_method_id ?? "").trim());
        if (!hasRef) return false;
        if (status === "active" || status === "verified") return true;
        return row.revolut_verified === true;
      })
      .map((row) => ({
        platform_payment_method_id: row.platform_payment_method_id,
        brand: row.brand,
        last4: row.last4,
        exp_month: row.exp_month,
        exp_year: row.exp_year,
      }));

    const unusable_cards = rows
      .filter((row) => String(row.tokenization_status ?? "") === "tokenization_failed")
      .filter((row) => Boolean(String(row.last4 ?? "").trim()))
      .map((row) => ({
        brand: row.brand,
        last4: row.last4,
        reason: "verification_failed" as const,
      }));

    console.log(JSON.stringify({
      fn: "list-revolut-saved-cards",
      event: "payment_method.list_loaded",
      edgeStatus: 200,
      authenticated: true,
      cardCount: cards.length,
      unusableCardCount: unusable_cards.length,
    }));

    return successResponse({ ready: true, cards, unusable_cards });
  } catch (err) {
    console.error(
      "[list-revolut-saved-cards]",
      err instanceof Error ? err.message : "unknown",
    );
    return errorJson("INTERNAL", 500, "Unable to load saved cards. Please try again.");
  }
});
