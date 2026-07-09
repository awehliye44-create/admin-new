/**
 * Provider-neutral platform balance SSOT for Financial Reconciliation.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getPaymentProviderAdapter, getActivePaymentProvider } from "./paymentProviders/index.ts";
import type { PaymentProviderId, ProviderEnvironment } from "./paymentProviders/types.ts";
import { isManualBankPayoutProvider } from "./manualProviderPayoutSSOT.ts";

export type FinanceScopeProvider = {
  provider: PaymentProviderId;
  environment: ProviderEnvironment;
  manual_provider_payout: boolean;
  display_name: string | null;
};

export type ProviderPlatformBalance = {
  available_pence: number;
  pending_pence: number;
  currency: string;
  provider: PaymentProviderId;
  environment: ProviderEnvironment;
  error: string | null;
};

function normalizeProviderId(value: string | null | undefined): PaymentProviderId | null {
  if (!value) return null;
  const id = value.trim().toLowerCase();
  if (id === "stripe" || id === "revolut") return id;
  return id as PaymentProviderId;
}

export async function resolveFinanceScopeProvider(
  supabase: SupabaseClient,
  args: { regionId?: string | null; serviceAreaId?: string | null },
): Promise<FinanceScopeProvider> {
  let providerId: PaymentProviderId | null = null;

  if (args.serviceAreaId) {
    const { data } = await supabase
      .from("service_areas")
      .select("payment_provider, driver_payout_gateway, customer_payment_gateway")
      .eq("id", args.serviceAreaId)
      .maybeSingle();
    providerId = normalizeProviderId(
      (data?.payment_provider as string | null)
        ?? (data?.driver_payout_gateway as string | null)
        ?? (data?.customer_payment_gateway as string | null),
    );
  } else if (args.regionId) {
    const { data: areas } = await supabase
      .from("service_areas")
      .select("payment_provider, driver_payout_gateway, customer_payment_gateway")
      .eq("region_id", args.regionId)
      .eq("is_active", true)
      .limit(1);
    const area = areas?.[0];
    providerId = normalizeProviderId(
      (area?.payment_provider as string | null)
        ?? (area?.driver_payout_gateway as string | null)
        ?? (area?.customer_payment_gateway as string | null),
    );
  }

  const fallback = await getActivePaymentProvider(supabase);
  const provider = providerId ?? fallback.provider;
  const { data: config } = await supabase
    .from("payment_provider_configs")
    .select("display_name, environment")
    .eq("provider", provider)
    .maybeSingle();

  const environment = (config?.environment === "test" ? "test" : fallback.environment) as ProviderEnvironment;

  return {
    provider,
    environment,
    manual_provider_payout: isManualBankPayoutProvider(provider),
    display_name: (config?.display_name as string | null) ?? provider,
  };
}

export async function fetchProviderPlatformBalance(
  supabase: SupabaseClient,
  args: {
    provider: PaymentProviderId;
    environment: ProviderEnvironment;
    currency: string;
  },
): Promise<ProviderPlatformBalance> {
  const currency = args.currency.toLowerCase();
  try {
    const adapter = getPaymentProviderAdapter(supabase, args.provider, args.environment);
    const balance = await adapter.getBalance(currency);
    return {
      available_pence: balance.available_pence,
      pending_pence: balance.pending_pence,
      currency: balance.currency,
      provider: args.provider,
      environment: args.environment,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
      ? String((error as { message: unknown }).message)
      : "Provider balance fetch failed";
    return {
      available_pence: 0,
      pending_pence: 0,
      currency,
      provider: args.provider,
      environment: args.environment,
      error: message,
    };
  }
}
