/**
 * Revolut Merchant API credentials — vault SSOT with edge env fallback.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { getProviderSecrets } from "./paymentProviders/secretManager.ts";
import { normalizeRevolutMerchantSecret } from "./revolutApi.ts";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";

export type RevolutMerchantContext = {
  secretKey: string;
  environment: ProviderEnvironment;
  publicKey: string | null;
  webhookSecret: string | null;
};

/**
 * Isolate-local cache only (no cross-isolate / no cross-environment bleed).
 * Keyed by provider environment. TTL bounds credential-rotation lag; a rotated
 * secret fails closed on Revolut API (confirm/CTAP never invent AUTHORISED).
 * No durable invalidation bus — freshness is TTL + cold isolate restart.
 */
export const MERCHANT_CONTEXT_TTL_MS = 30_000;
export const merchantContextCache = new Map<
  string,
  { expiresAt: number; value: RevolutMerchantContext }
>();

function isPlaceholder(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  return !v || v.includes("•") || v.includes("****");
}

export async function resolveRevolutMerchantContext(
  supabase: SupabaseClient,
  environment: ProviderEnvironment = "live",
): Promise<RevolutMerchantContext> {
  const cacheKey = `revolut:${environment}`;
  const cached = merchantContextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const secrets = await getProviderSecrets(supabase, "revolut", environment);
  const rawSecret =
    secrets.secret_key?.trim()
    || Deno.env.get("REVOLUT_MERCHANT_SECRET_KEY")?.trim()
    || null;

  if (!rawSecret || isPlaceholder(rawSecret)) {
    throw new Error(
      "Revolut payment is not configured for this area. Please try again later or contact support.",
    );
  }

  const secretKey = normalizeRevolutMerchantSecret(rawSecret);
  const publicKey =
    secrets.publishable_key?.trim()
    || Deno.env.get("REVOLUT_PUBLIC_KEY")?.trim()
    || null;
  const webhookSecret =
    secrets.webhook_secret?.trim()
    || Deno.env.get("REVOLUT_WEBHOOK_SECRET")?.trim()
    || null;

  const value: RevolutMerchantContext = {
    secretKey,
    environment,
    publicKey: publicKey && !isPlaceholder(publicKey) ? publicKey : null,
    webhookSecret: webhookSecret && !isPlaceholder(webhookSecret) ? webhookSecret : null,
  };
  merchantContextCache.set(cacheKey, {
    expiresAt: Date.now() + MERCHANT_CONTEXT_TTL_MS,
    value,
  });
  return value;
}
