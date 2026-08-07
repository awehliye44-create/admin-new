import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createPlaceholderAdapter } from "./placeholderAdapter.ts";
import { createRevolutAdapter } from "./revolutAdapter.ts";
import { getProviderSecrets } from "./secretManager.ts";
import type { PaymentProviderAdapter, PaymentProviderId, ProviderEnvironment } from "./types.ts";

export * from "./types.ts";
export * from "./secretManager.ts";

/** Active payment providers after Stripe runtime retirement. */
export type ActivePaymentProvider =
  | "revolut"
  | "bank_transfer"
  | "unknown"
  | "unavailable";

export function resolveActivePaymentProviderName(
  raw: string | null | undefined,
): ActivePaymentProvider {
  const p = String(raw ?? "").trim().toLowerCase();
  if (!p) return "unavailable";
  if (p === "stripe") return "unavailable";
  if (p === "revolut") return "revolut";
  if (p === "bank_transfer" || p === "manual" || p === "manual_bank") return "bank_transfer";
  if (p === "unknown") return "unknown";
  if (p === "unavailable" || p === "none") return "unavailable";
  return "unknown";
}

export function getPaymentProviderAdapter(
  supabase: SupabaseClient,
  provider: PaymentProviderId,
  environment: ProviderEnvironment,
  options?: { updatedBy?: string },
): PaymentProviderAdapter {
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

  console.info(JSON.stringify({
    event: "PAYMENT_PROVIDER_UNAVAILABLE",
    function: "getActivePaymentProvider",
    operation: "resolve_active_provider",
    timestamp: new Date().toISOString(),
  }));
  return { provider: "revolut", environment };
}
