/**
 * Payment provider readiness SSOT — vault-backed credential checks shared by
 * Settings → Payment Providers and Service Area gateway status.
 * Never infer readiness from payment_provider_secret_metadata alone.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  getProviderSecrets,
  secretStatus,
} from "./paymentProviders/secretManager.ts";
import type {
  PaymentProviderId,
  ProviderEnvironment,
  ProviderSecrets,
} from "./paymentProviders/types.ts";
import {
  isCustomerBookingAdapterLive,
  isPayoutAdapterLive,
} from "./customerPaymentWorkflow.ts";

export type AdapterReadinessStatus = "live" | "not_implemented" | "not_configured";

export type ProviderCredentialReadiness = {
  secrets: ProviderSecrets;
  credentials_ready: boolean;
  api_key_status: "added" | "missing";
  webhook_secret_status: "added" | "missing";
  booking_adapter_live: boolean;
  payout_adapter_live: boolean;
  booking_adapter_status: AdapterReadinessStatus;
  payout_adapter_status: AdapterReadinessStatus;
};

export function resolveAdapterReadinessStatus(
  adapterLive: boolean,
  credentialsReady: boolean,
): AdapterReadinessStatus {
  if (!credentialsReady) return "not_configured";
  if (adapterLive) return "live";
  return "not_implemented";
}

export async function loadPaymentProviderCredentialReadiness(
  supabase: SupabaseClient,
  provider: PaymentProviderId,
  environment: ProviderEnvironment,
): Promise<ProviderCredentialReadiness> {
  const secrets = await getProviderSecrets(supabase, provider, environment);
  const statuses = secretStatus(secrets);
  const credentials_ready = Boolean(secrets.secret_key?.trim());
  const booking_adapter_live = isCustomerBookingAdapterLive(provider);
  const payout_adapter_live = isPayoutAdapterLive(provider);

  return {
    secrets,
    credentials_ready,
    api_key_status: statuses.api_key,
    webhook_secret_status: statuses.webhook,
    booking_adapter_live,
    payout_adapter_live,
    booking_adapter_status: resolveAdapterReadinessStatus(
      booking_adapter_live,
      credentials_ready,
    ),
    payout_adapter_status: resolveAdapterReadinessStatus(
      payout_adapter_live,
      credentials_ready,
    ),
  };
}

export type ProviderBookingWorkflow =
  | "stripe_preauth"
  | "revolut_merchant"
  | "mobile_wallet_collect"
  | "blocked"
  | "not_configured";

export function resolveProviderBookingWorkflow(
  provider: string | null | undefined,
  readyForProduction: boolean,
): ProviderBookingWorkflow {
  if (!provider) return "not_configured";
  if (!readyForProduction) return "blocked";
  if (provider === "stripe") return "stripe_preauth";
  if (provider === "revolut") return "revolut_merchant";
  if (provider in PROVIDER_MOBILE_WALLET_CATALOG) return "mobile_wallet_collect";
  return "blocked";
}

const PROVIDER_MOBILE_WALLET_CATALOG: Record<string, string[]> = {
  sifalo_pay: [],
  intasend: [],
  waafi_pay: [],
  sahal_pay: [],
};
