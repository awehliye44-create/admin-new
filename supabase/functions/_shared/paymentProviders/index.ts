import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createPlaceholderAdapter } from "./placeholderAdapter.ts";
import { createRevolutAdapter } from "./revolutAdapter.ts";
import { createStripeAdapter } from "./stripeAdapter.ts";
import { getProviderSecrets } from "./secretManager.ts";
import type { PaymentProviderAdapter, PaymentProviderId, ProviderEnvironment } from "./types.ts";
import {
  emitStripeRetirementTelemetry,
  isStripeRuntimeDisabled,
  PAYMENT_PROVIDER_UNAVAILABLE,
  resolveActivePaymentProviderName,
  STRIPE_FALLBACK_PREVENTED,
  STRIPE_RETIRED,
} from "../stripeRuntimeDisabled.ts";

export * from "./types.ts";
export * from "./secretManager.ts";

export function getPaymentProviderAdapter(
  supabase: SupabaseClient,
  provider: PaymentProviderId,
  environment: ProviderEnvironment,
  options?: { updatedBy?: string },
): PaymentProviderAdapter {
  if (provider === "stripe") {
    if (isStripeRuntimeDisabled()) {
      emitStripeRetirementTelemetry({
        event: STRIPE_FALLBACK_PREVENTED,
        function: "getPaymentProviderAdapter",
        operation: "create_stripe_adapter",
      });
      throw new Error(STRIPE_RETIRED);
    }
    return createStripeAdapter(supabase, environment);
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

  emitStripeRetirementTelemetry({
    event: PAYMENT_PROVIDER_UNAVAILABLE,
    function: "getActivePaymentProvider",
    operation: "resolve_active_provider",
  });
  return { provider: "revolut", environment };
}
