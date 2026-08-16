import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createPlaceholderAdapter } from "./placeholderAdapter.ts";
import { createRevolutAdapter } from "./revolutAdapter.ts";
import { getProviderSecrets } from "./secretManager.ts";
import type { PaymentProviderAdapter, PaymentProviderId, ProviderEnvironment } from "./types.ts";

export * from "./types.ts";
export * from "./secretManager.ts";

function resolveActivePaymentProviderName(
  raw: string | null | undefined,
): "revolut" | "unavailable" {
  const p = String(raw ?? "").trim().toLowerCase();
  if (p === "revolut") return "revolut";
  return "unavailable";
}

export function getPaymentProviderAdapter(
  supabase: SupabaseClient,
  provider: PaymentProviderId,
  environment: ProviderEnvironment,
  options?: { updatedBy?: string },
): PaymentProviderAdapter {
  if (provider === "stripe") {
    throw new Error("PAYMENT_PROVIDER_UNAVAILABLE");
  }
  switch (provider) {
    case "revolut":
      return createRevolutAdapter(supabase, environment, options);
    default:
      return createPlaceholderAdapter(provider, () =>
        getProviderSecrets(supabase, provider, environment)
      );
  }
}

export async function getActivePaymentProvider(
  supabase: SupabaseClient,
): Promise<{ provider: PaymentProviderId; environment: ProviderEnvironment }> {
  const { data } = await supabase
    .from("payment_provider_configs")
    .select("provider, environment")
    .eq("is_primary", true)
    .eq("is_enabled", true)
    .maybeSingle();

  const resolved = resolveActivePaymentProviderName(data?.provider as string | null);
  const environment = (data?.environment as ProviderEnvironment) ?? "live";

  if (resolved === "revolut") {
    return { provider: "revolut", environment };
  }

  // Default to Revolut environment for callers that need a non-null adapter context;
  // they must still check provider readiness before charging.
  return { provider: "revolut", environment };
}
