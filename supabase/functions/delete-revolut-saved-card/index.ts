/**
 * delete-revolut-saved-card — Customer JWT → remove saved card after ownership check.
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
import { getRevolutMerchantConfig } from "../_shared/revolutOrders.ts";
import {
  deleteRevolutCustomerPaymentMethod,
  loadCustomerForUser,
} from "../_shared/revolutSavedCardVault.ts";

const RATE_LIMIT_CONFIG = { limit: 20, windowMs: 60 * 1000 };

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
      return errorJson(
        "REVOLUT_SAVED_CARD_NOT_IMPLEMENTED",
        503,
        "Unable to remove card. Please try again.",
      );
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

    const body = await req.json().catch(() => ({}));
    const platformPaymentMethodId =
      typeof body.platform_payment_method_id === "string"
        ? body.platform_payment_method_id.trim()
        : "";
    if (!platformPaymentMethodId) {
      return errorJson(
        "VALIDATION_MISSING_FIELD",
        400,
        "Unable to remove card. Please try again.",
      );
    }

    const { data: row, error: fetchErr } = await supabase
      .from("customer_saved_payment_method_tokens")
      .select("id, provider_payment_method_id, payment_provider")
      .eq("user_id", user.id)
      .eq("platform_payment_method_id", platformPaymentMethodId)
      .maybeSingle();

    if (fetchErr) {
      console.error("[delete-revolut-saved-card] fetch", fetchErr.message);
      return errorJson("DB_ERROR", 500, "Unable to remove card. Please try again.");
    }
    if (!row) {
      return errorJson("SAVED_CARD_NOT_FOUND", 404, "Unable to remove card. Please try again.");
    }

    if (row.payment_provider === "revolut" && row.provider_payment_method_id) {
      try {
        const { secretKey, environment } = getRevolutMerchantConfig();
        const customer = await loadCustomerForUser(supabase, user.id);
        if (customer?.revolut_customer_id) {
          await deleteRevolutCustomerPaymentMethod({
            environment,
            secretKey,
            revolutCustomerId: customer.revolut_customer_id,
            providerPaymentMethodId: row.provider_payment_method_id,
          });
        }
      } catch (revolutErr) {
        console.warn(
          "[delete-revolut-saved-card] revolut delete failed",
          revolutErr instanceof Error ? revolutErr.message : "unknown",
        );
      }
    }

    const { error: deleteErr } = await supabase
      .from("customer_saved_payment_method_tokens")
      .delete()
      .eq("id", row.id)
      .eq("user_id", user.id);

    if (deleteErr) {
      console.error("[delete-revolut-saved-card] delete", deleteErr.message);
      return errorJson("DB_ERROR", 500, "Unable to remove card. Please try again.");
    }

    console.log(JSON.stringify({
      fn: "delete-revolut-saved-card",
      edgeStatus: 200,
      authenticated: true,
      deleted: true,
    }));

    return successResponse({ success: true, deleted: true });
  } catch (err) {
    console.error(
      "[delete-revolut-saved-card]",
      err instanceof Error ? err.message : "unknown",
    );
    return errorJson("INTERNAL", 500, "Unable to remove card. Please try again.");
  }
});
