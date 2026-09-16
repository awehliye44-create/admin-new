/**
 * get-revolut-checkout-client-config
 *
 * Customer JWT → safe Revolut publishable key (pk_ only) for native SDK configure.
 * SSOT: LIVE payment_provider_vault.publishable_key first; env only as last resort.
 * Never returns sk_ secrets. Never silently falls back to the test vault for live apps.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  checkRateLimit,
  getClientIP,
  jsonHeaders,
  nativeAppCorsHeaders,
  rateLimitResponse,
} from "../_shared/security.ts";

const RATE_LIMIT_CONFIG = { limit: 120, windowMs: 60 * 1000 };

function pickPublishableKey(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const c of candidates) {
    const v = String(c ?? "").trim();
    // Reject secrets and non-publishable values.
    if (!v || v.startsWith("sk_") || v.includes("•") || v.includes("****")) continue;
    if (v.startsWith("pk_")) return v;
  }
  return null;
}

function inferEnvironment(
  publicKey: string,
  vaultEnv?: "live" | "test",
): "sandbox" | "production" {
  if (vaultEnv === "test") return "sandbox";
  if (vaultEnv === "live") return "production";
  const lower = publicKey.toLowerCase();
  if (lower.includes("sandbox") || lower.includes("_test_")) return "sandbox";
  return "production";
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

async function readVaultPublishableKey(
  supabase: ReturnType<typeof createClient>,
  environment: "live" | "test",
): Promise<string | null> {
  const { data, error } = await supabase
    .from("payment_provider_vault")
    .select("secret_value")
    .eq("provider", "revolut")
    .eq("environment", environment)
    .eq("secret_name", "publishable_key")
    .maybeSingle();
  if (error) {
    console.error(
      "[get-revolut-checkout-client-config] vault read failed",
      environment,
      error.message,
    );
    return null;
  }
  return pickPublishableKey(data?.secret_value);
}

async function resolvePublishableKey(
  supabase: ReturnType<typeof createClient>,
): Promise<{
  publicKey: string | null;
  environment: "sandbox" | "production";
  applePayMerchantId: string | null;
  source: "vault_live" | "env" | "none";
}> {
  const appleFromEnv = String(Deno.env.get("APPLE_PAY_MERCHANT_ID") ?? "").trim();
  const applePayMerchantId = appleFromEnv.startsWith("merchant.") ? appleFromEnv : null;

  // Prefer LIVE vault — never prefer test vault for customer checkout config.
  const liveKey = await readVaultPublishableKey(supabase, "live");
  if (liveKey) {
    return {
      publicKey: liveKey,
      environment: inferEnvironment(liveKey, "live"),
      applePayMerchantId,
      source: "vault_live",
    };
  }

  // Env fallback only when live vault has no valid pk_ (still reject sk_/malformed).
  const envPublicKey = pickPublishableKey(
    Deno.env.get("REVOLUT_PUBLIC_KEY"),
    Deno.env.get("REVOLUT_MERCHANT_PUBLIC_KEY"),
  );
  if (envPublicKey) {
    return {
      publicKey: envPublicKey,
      environment: inferEnvironment(envPublicKey),
      applePayMerchantId,
      source: "env",
    };
  }

  return {
    publicKey: null,
    environment: "production",
    applePayMerchantId,
    source: "none",
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: nativeAppCorsHeaders });
  }

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      return jsonResponse(
        {
          error: "AUTH_MISSING",
          code: "AUTH_MISSING",
          message: "Missing authorization header",
        },
        401,
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: { user }, error: authErr } = await supabase.auth.getUser(
      auth.replace("Bearer ", ""),
    );
    if (authErr || !user) {
      return jsonResponse(
        { error: "AUTH_INVALID", code: "AUTH_INVALID", message: "Unauthorized" },
        401,
      );
    }

    const { publicKey, environment, applePayMerchantId, source } =
      await resolvePublishableKey(supabase);

    if (!publicKey) {
      console.error(
        "[get-revolut-checkout-client-config] No live pk_ in vault and no valid env pk_",
      );
      return jsonResponse(
        {
          error: "PAYMENT_GATEWAY_NOT_CONFIGURED",
          code: "PAYMENT_GATEWAY_NOT_CONFIGURED",
          message: "Revolut publishable key is not configured in the live vault",
        },
        503,
      );
    }

    // Safe structured log — never log the key value.
    console.log(
      JSON.stringify({
        fn: "get-revolut-checkout-client-config",
        keyPresent: true,
        keyPrefixValid: publicKey.startsWith("pk_"),
        environment,
        source,
        applePayMerchantConfigured: Boolean(applePayMerchantId),
      }),
    );

    return jsonResponse({
      success: true,
      revolut_public_key: publicKey,
      apple_pay_merchant_id: applePayMerchantId,
      environment,
      card_enabled: true,
      apple_pay_enabled: Boolean(applePayMerchantId),
      google_pay_enabled: true,
    });
  } catch (err) {
    console.error(
      "[get-revolut-checkout-client-config]",
      err instanceof Error ? err.message : err,
    );
    return jsonResponse(
      { error: "INTERNAL", code: "INTERNAL", message: "Internal error" },
      500,
    );
  }
});
