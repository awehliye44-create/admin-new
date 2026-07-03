/**
 * Read-only payment gateway guard — mirrored from onecab-comfy-ride.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const PAYMENT_GATEWAY_NOT_CONFIGURED = "PAYMENT_GATEWAY_NOT_CONFIGURED";

export type GatewayRole = "customer" | "driver";

export type ServiceAreaGatewayResolution = {
  service_area_id: string;
  customer_payment_gateway: string | null;
  driver_payout_gateway: string | null;
};

export type GatewayConfiguredResult = {
  ok: true;
  provider: string;
  environment: "test" | "live";
  display_name: string;
  role: GatewayRole;
};

export type GatewayNotConfiguredResult = {
  ok: false;
  code: typeof PAYMENT_GATEWAY_NOT_CONFIGURED;
  role: GatewayRole;
  provider: string | null;
  reason: string;
};

export type GatewayCheckResult = GatewayConfiguredResult | GatewayNotConfiguredResult;

type ProviderRow = {
  provider: string;
  display_name: string;
  environment: string;
  status: string;
  is_enabled: boolean;
  supports_customer_payments: boolean;
  supports_driver_payouts: boolean;
};

export async function loadServiceAreaGateways(
  supabase: SupabaseClient,
  serviceAreaId: string,
): Promise<ServiceAreaGatewayResolution | null> {
  const { data, error } = await supabase
    .from("service_areas")
    .select("id, customer_payment_gateway, driver_payout_gateway")
    .eq("id", serviceAreaId)
    .maybeSingle();

  if (error || !data) return null;

  return {
    service_area_id: data.id as string,
    customer_payment_gateway: (data.customer_payment_gateway as string | null) ?? null,
    driver_payout_gateway: (data.driver_payout_gateway as string | null) ?? null,
  };
}

async function loadProviderConfig(
  supabase: SupabaseClient,
  provider: string,
): Promise<ProviderRow | null> {
  const { data } = await supabase
    .from("payment_provider_configs")
    .select(
      "provider, display_name, environment, status, is_enabled, supports_customer_payments, supports_driver_payouts",
    )
    .eq("provider", provider)
    .maybeSingle();

  return data as ProviderRow | null;
}

async function isProviderOperational(
  supabase: SupabaseClient,
  provider: string,
  environment: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("payment_provider_secret_metadata")
    .select("is_configured")
    .eq("provider", provider)
    .eq("environment", environment)
    .eq("secret_name", "secret_key")
    .maybeSingle();

  if (data?.is_configured === true) return true;
  if (provider === "stripe" && Deno.env.get("STRIPE_SECRET_KEY")) return true;
  return false;
}

export async function checkServiceAreaGateway(
  supabase: SupabaseClient,
  serviceAreaId: string,
  role: GatewayRole,
): Promise<GatewayCheckResult> {
  const gateways = await loadServiceAreaGateways(supabase, serviceAreaId);
  if (!gateways) {
    return {
      ok: false,
      code: PAYMENT_GATEWAY_NOT_CONFIGURED,
      role,
      provider: null,
      reason: "Service area not found",
    };
  }

  const providerId = role === "customer"
    ? gateways.customer_payment_gateway
    : gateways.driver_payout_gateway;

  if (!providerId) {
    return {
      ok: false,
      code: PAYMENT_GATEWAY_NOT_CONFIGURED,
      role,
      provider: null,
      reason: role === "customer"
        ? "Customer payment gateway not selected for this service area"
        : "Driver payout gateway not selected for this service area",
    };
  }

  const config = await loadProviderConfig(supabase, providerId);
  if (!config) {
    return {
      ok: false,
      code: PAYMENT_GATEWAY_NOT_CONFIGURED,
      role,
      provider: providerId,
      reason: "Payment provider is not registered",
    };
  }

  const supportsRole = role === "customer"
    ? config.supports_customer_payments
    : config.supports_driver_payouts;

  if (!supportsRole) {
    return {
      ok: false,
      code: PAYMENT_GATEWAY_NOT_CONFIGURED,
      role,
      provider: providerId,
      reason: `Provider ${config.display_name} does not support ${role} payments`,
    };
  }

  if (!config.is_enabled || config.status === "not_configured" || config.status === "error") {
    return {
      ok: false,
      code: PAYMENT_GATEWAY_NOT_CONFIGURED,
      role,
      provider: providerId,
      reason: `Provider ${config.display_name} is not enabled or connected`,
    };
  }

  const environment = (config.environment === "test" ? "test" : "live") as "test" | "live";
  const operational = await isProviderOperational(supabase, providerId, environment);
  if (!operational) {
    return {
      ok: false,
      code: PAYMENT_GATEWAY_NOT_CONFIGURED,
      role,
      provider: providerId,
      reason: `Provider ${config.display_name} secrets are not configured`,
    };
  }

  return {
    ok: true,
    provider: providerId,
    environment,
    display_name: config.display_name,
    role,
  };
}

export function assertGatewayExecutable(check: GatewayCheckResult): GatewayCheckResult {
  if (!check.ok) return check;
  if (check.provider !== "stripe") {
    return {
      ok: false,
      code: PAYMENT_GATEWAY_NOT_CONFIGURED,
      role: check.role,
      provider: check.provider,
      reason: `${check.display_name} is registered but not yet enabled for live booking`,
    };
  }
  return check;
}

export function gatewayNotConfiguredResponse(
  check: GatewayNotConfiguredResult,
  corsHeaders: Record<string, string>,
  status = 422,
): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: check.code,
      code: check.code,
      role: check.role,
      provider: check.provider,
      message: check.reason,
    }),
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}
