/**
 * list-revolut-saved-cards — Customer JWT → saved card rows for the wallet sheet.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  checkRateLimit,
  getClientIP,
  jsonHeaders,
  nativeAppCorsHeaders,
  rateLimitResponse,
  successResponse,
} from "../_shared/security.ts";
import { REVOLUT_SAVE_CARD_TOKENIZATION_READY } from "../_shared/paymentMethodSSOT.ts";

const RATE_LIMIT_CONFIG = { limit: 60, windowMs: 60 * 1000 };

function errorJson(code: string, status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: code, code, message }),
    { status, headers: jsonHeaders },
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: nativeAppCorsHeaders });
  }

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter!);

  try {
    if (!REVOLUT_SAVE_CARD_TOKENIZATION_READY) {
      return successResponse({ success: true, cards: [], ready: false });
    }

    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      return errorJson("AUTH_MISSING", 401, "Please sign in again to continue.");
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: { user }, error: authErr } = await supabase.auth.getUser(
      auth.replace("Bearer ", ""),
    );
    if (authErr || !user) {
      return errorJson("AUTH_INVALID", 401, "Please sign in again to continue.");
    }

    // Booking confirm/capture writes tokenization_status=verified (+ revolut_verified).
    // Standalone setup-revolut-card writes tokenization_status=active.
    // Both are listable; failed tokenisation must stay hidden.
    const { data, error } = await supabase
      .from("customer_saved_payment_method_tokens")
      .select(
        "platform_payment_method_id, brand, last4, exp_month, exp_year, provider_payment_method_id, created_at, tokenization_status, revolut_verified",
      )
      .eq("user_id", user.id)
      .eq("payment_provider", "revolut")
      .neq("tokenization_status", "tokenization_failed")
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[list-revolut-saved-cards]", error.message);
      return errorJson("DB_ERROR", 500, "Unable to load saved cards. Please try again.");
    }

    const cards = (data ?? [])
      .filter((row) => {
        const status = String(row.tokenization_status ?? "");
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

    console.log(JSON.stringify({
      fn: "list-revolut-saved-cards",
      edgeStatus: 200,
      authenticated: true,
      cardCount: cards.length,
    }));

    return successResponse({ success: true, ready: true, cards });
  } catch (err) {
    console.error("[list-revolut-saved-cards]", err instanceof Error ? err.message : "unknown");
    return errorJson("INTERNAL", 500, "Unable to load saved cards. Please try again.");
  }
});
