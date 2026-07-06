import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type PaymentProviderId,
  type ProviderEnvironment,
  type ProviderSecrets,
  PROVIDER_ENV_SECRET_MAP,
  PROVIDER_ENV_SECRET_FALLBACKS,
  PROVIDER_SECRET_FIELDS,
} from "./types.ts";

export function maskSecretValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return "••••••••";
  const prefixMatch = trimmed.match(/^(sk_(?:live|test)_|pk_(?:live|test)_|whsec_)/i);
  const prefix = prefixMatch?.[1] ?? trimmed.slice(0, Math.min(8, trimmed.length - 4));
  const suffix = trimmed.slice(-4);
  return `${prefix}••••${suffix}`;
}

export async function getProviderSecrets(
  supabase: SupabaseClient,
  provider: PaymentProviderId,
  environment: ProviderEnvironment,
): Promise<ProviderSecrets> {
  const envMap = PROVIDER_ENV_SECRET_MAP[provider];
  const names = PROVIDER_SECRET_FIELDS[provider];
  const result: ProviderSecrets = {};

  const { data: vaultRows } = await supabase
    .from("payment_provider_vault")
    .select("secret_name, secret_value")
    .eq("provider", provider)
    .eq("environment", environment);

  const vaultByName = new Map(
    (vaultRows ?? []).map((r) => [r.secret_name, r.secret_value as string]),
  );

  for (const name of names) {
    const vaultValue = vaultByName.get(name);
    if (vaultValue) {
      result[name] = vaultValue;
      continue;
    }
    const envVar = envMap[name];
    if (envVar) {
      const envValue = Deno.env.get(envVar);
      if (envValue) {
        result[name] = envValue;
        continue;
      }
    }
    const fallbacks = PROVIDER_ENV_SECRET_FALLBACKS[provider]?.[name] ?? [];
    for (const fallbackVar of fallbacks) {
      const fallbackValue = Deno.env.get(fallbackVar);
      if (fallbackValue) {
        result[name] = fallbackValue;
        break;
      }
    }
  }

  // WaafiPay: legacy vault stored merchant id under publishable_key
  if (provider === "waafi_pay" && !result.merchant_id) {
    const legacy = vaultByName.get("publishable_key");
    if (legacy) result.merchant_id = legacy;
  }

  return result;
}

export async function upsertProviderSecret(
  supabase: SupabaseClient,
  args: {
    provider: PaymentProviderId;
    environment: ProviderEnvironment;
    secretName: keyof ProviderSecrets;
    secretValue: string;
    updatedBy: string;
  },
): Promise<void> {
  const { provider, environment, secretName, secretValue, updatedBy } = args;
  const masked = maskSecretValue(secretValue);

  const { error: vaultError } = await supabase.from("payment_provider_vault").upsert(
    {
      provider,
      environment,
      secret_name: secretName,
      secret_value: secretValue,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    },
    { onConflict: "provider,environment,secret_name" },
  );
  if (vaultError) throw vaultError;

  const { error: metaError } = await supabase.from("payment_provider_secret_metadata").upsert(
    {
      provider,
      environment,
      secret_name: secretName,
      masked_value: masked,
      is_configured: true,
      last_updated: new Date().toISOString(),
      updated_by: updatedBy,
    },
    { onConflict: "provider,environment,secret_name" },
  );
  if (metaError) throw metaError;
}

export function detectModeMismatch(
  environment: ProviderEnvironment,
  secretKey?: string,
): string | null {
  if (!secretKey) return null;
  const isLiveKey = secretKey.includes("_live_");
  const isTestKey = secretKey.includes("_test_");
  if (environment === "live" && isTestKey) {
    return "Critical: test mode secret key configured while provider is set to Live mode.";
  }
  if (environment === "test" && isLiveKey) {
    return "Critical: live mode secret key configured while provider is set to Test mode.";
  }
  return null;
}

export function secretStatus(
  secrets: ProviderSecrets,
): { api_key: "added" | "missing"; webhook: "added" | "missing" } {
  return {
    api_key: secrets.secret_key ? "added" : "missing",
    webhook: secrets.webhook_secret ? "added" : "missing",
  };
}
