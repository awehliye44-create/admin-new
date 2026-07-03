/**
 * Payment gateway operational status — backend SSOT.
 * Dropdown selection ≠ operational status. Never infer from provider row alone.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { isCustomerBookingAdapterLive } from "./customerPaymentWorkflow.ts";
import type { GatewayRole } from "./paymentGatewayGuard.ts";

export type PaymentGatewayStatusCode =
  | "CONNECTED"
  | "NOT_CONFIGURED"
  | "DISABLED"
  | "CONNECTION_FAILED"
  | "TEST_MODE";

export type GatewayStatusSnapshot = {
  status: PaymentGatewayStatusCode;
  badge_label: string;
  badge_emoji: string;
  provider: string | null;
  display_name: string | null;
  role: GatewayRole;
  environment: "test" | "live" | null;
  configured: boolean;
  ready_for_production: boolean;
  message: string | null;
  configuration_error: string | null;
  health: {
    api_keys_configured: boolean;
    webhook_configured: boolean | null;
    webhook_healthy: boolean | null;
    enabled: boolean;
    supports_role: boolean;
    last_connection_test_at: string | null;
    last_connection_test_status: string | null;
    last_error_message: string | null;
    last_webhook_at: string | null;
  };
};

type ProviderRow = {
  provider: string;
  display_name: string;
  environment: string;
  status: string;
  is_enabled: boolean;
  supports_customer_payments: boolean;
  supports_driver_payouts: boolean;
  last_connection_test_at: string | null;
  last_connection_test_status: string | null;
  last_error_message: string | null;
  webhook_endpoint_url: string | null;
};

const STRIPE_MONITORED_EVENTS = [
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.succeeded",
  "charge.refunded",
  "account.updated",
  "transfer.created",
  "payout.paid",
  "payout.failed",
];

export function gatewayStatusBadge(status: PaymentGatewayStatusCode): {
  label: string;
  emoji: string;
} {
  switch (status) {
    case "CONNECTED":
      return { label: "Connected", emoji: "🟢" };
    case "NOT_CONFIGURED":
      return { label: "Not Configured", emoji: "⚪" };
    case "DISABLED":
      return { label: "Disabled", emoji: "🟡" };
    case "CONNECTION_FAILED":
      return { label: "Connection Failed", emoji: "🔴" };
    case "TEST_MODE":
      return { label: "Test Mode", emoji: "🔵" };
  }
}

function supportsRole(config: ProviderRow, role: GatewayRole): boolean {
  return role === "customer"
    ? config.supports_customer_payments
    : config.supports_driver_payouts;
}

async function loadProviderConfig(
  supabase: SupabaseClient,
  provider: string,
): Promise<ProviderRow | null> {
  const { data } = await supabase
    .from("payment_provider_configs")
    .select(
      "provider, display_name, environment, status, is_enabled, supports_customer_payments, supports_driver_payouts, last_connection_test_at, last_connection_test_status, last_error_message, webhook_endpoint_url",
    )
    .eq("provider", provider)
    .maybeSingle();
  return data as ProviderRow | null;
}

async function hasSecretKeyConfigured(
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

async function hasWebhookSecretConfigured(
  supabase: SupabaseClient,
  provider: string,
  environment: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("payment_provider_secret_metadata")
    .select("is_configured")
    .eq("provider", provider)
    .eq("environment", environment)
    .eq("secret_name", "webhook_secret")
    .maybeSingle();

  if (data?.is_configured === true) return true;
  if (provider === "stripe" && Deno.env.get("STRIPE_WEBHOOK_SECRET")) return true;
  return false;
}

async function loadStripeWebhookHealth(
  supabase: SupabaseClient,
): Promise<{
  healthy: boolean | null;
  last_webhook_at: string | null;
  failing: boolean;
}> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [recentResult, successResult, failedResult] = await Promise.all([
    supabase
      .from("processed_stripe_events")
      .select("processed_at")
      .in("event_type", STRIPE_MONITORED_EVENTS)
      .order("processed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("processed_stripe_events")
      .select("id", { count: "exact", head: true })
      .in("event_type", STRIPE_MONITORED_EVENTS)
      .eq("status", "processed")
      .gte("processed_at", since24h),
    supabase
      .from("processed_stripe_events")
      .select("id", { count: "exact", head: true })
      .in("event_type", STRIPE_MONITORED_EVENTS)
      .in("status", ["failed_retry", "failed_non_retry"])
      .gte("processed_at", since24h),
  ]);

  const lastWebhookAt = (recentResult.data?.processed_at as string | null) ?? null;
  const successCount = successResult.count ?? 0;
  const failureCount = failedResult.count ?? 0;

  if (!lastWebhookAt) {
    return { healthy: null, last_webhook_at: null, failing: false };
  }

  const failing = failureCount > 0 && successCount === 0;
  const healthy = !failing && (successCount > 0 || failureCount === 0);
  return { healthy, last_webhook_at: lastWebhookAt, failing };
}

function secretLooksTestMode(secretKeyPresent: boolean, provider: string): boolean {
  if (!secretKeyPresent || provider !== "stripe") return false;
  const key = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  return key.includes("_test_");
}

function buildSnapshot(
  role: GatewayRole,
  providerId: string | null,
  config: ProviderRow | null,
  args: {
    apiKeysConfigured: boolean;
    webhookConfigured: boolean | null;
    webhookHealthy: boolean | null;
    lastWebhookAt: string | null;
    status: PaymentGatewayStatusCode;
    message: string;
    configurationError: string | null;
  },
): GatewayStatusSnapshot {
  const badge = gatewayStatusBadge(args.status);
  const environment = config
    ? ((config.environment === "test" ? "test" : "live") as "test" | "live")
    : null;

  return {
    status: args.status,
    badge_label: badge.label,
    badge_emoji: badge.emoji,
    provider: providerId,
    display_name: config?.display_name ?? null,
    role,
    environment,
    configured: args.apiKeysConfigured,
    ready_for_production:
      args.status === "CONNECTED" &&
      Boolean(providerId && isCustomerBookingAdapterLive(providerId)),
    message: args.message,
    configuration_error: args.configurationError,
    health: {
      api_keys_configured: args.apiKeysConfigured,
      webhook_configured: args.webhookConfigured,
      webhook_healthy: args.webhookHealthy,
      enabled: config?.is_enabled === true,
      supports_role: config ? supportsRole(config, role) : false,
      last_connection_test_at: config?.last_connection_test_at ?? null,
      last_connection_test_status: config?.last_connection_test_status ?? null,
      last_error_message: config?.last_error_message ?? null,
      last_webhook_at: args.lastWebhookAt,
    },
  };
}

export async function resolveProviderGatewayStatus(
  supabase: SupabaseClient,
  providerId: string | null | undefined,
  role: GatewayRole,
): Promise<GatewayStatusSnapshot> {
  if (!providerId) {
    return buildSnapshot(role, null, null, {
      apiKeysConfigured: false,
      webhookConfigured: null,
      webhookHealthy: null,
      lastWebhookAt: null,
      status: "NOT_CONFIGURED",
      message: role === "customer"
        ? "Customer payment gateway not selected for this service area"
        : "Driver payout gateway not selected for this service area",
      configurationError: "Gateway not selected",
    });
  }

  const config = await loadProviderConfig(supabase, providerId);
  if (!config) {
    return buildSnapshot(role, providerId, null, {
      apiKeysConfigured: false,
      webhookConfigured: null,
      webhookHealthy: null,
      lastWebhookAt: null,
      status: "NOT_CONFIGURED",
      message: "Payment provider is not registered",
      configurationError: "Provider not registered",
    });
  }

  if (!supportsRole(config, role)) {
    return buildSnapshot(role, providerId, config, {
      apiKeysConfigured: false,
      webhookConfigured: null,
      webhookHealthy: null,
      lastWebhookAt: null,
      status: "NOT_CONFIGURED",
      message: `Provider ${config.display_name} does not support ${role} payments`,
      configurationError: "Provider does not support this gateway role",
    });
  }

  if (!config.is_enabled) {
    return buildSnapshot(role, providerId, config, {
      apiKeysConfigured: false,
      webhookConfigured: null,
      webhookHealthy: null,
      lastWebhookAt: null,
      status: "DISABLED",
      message: `Provider ${config.display_name} is disabled by admin`,
      configurationError: "Provider disabled",
    });
  }

  const environment = config.environment === "test" ? "test" : "live";
  const apiKeysConfigured = await hasSecretKeyConfigured(supabase, providerId, environment);

  let webhookConfigured: boolean | null = null;
  let webhookHealthy: boolean | null = null;
  let lastWebhookAt: string | null = null;

  if (providerId === "stripe") {
    webhookConfigured = await hasWebhookSecretConfigured(supabase, providerId, environment);
    const webhookHealth = await loadStripeWebhookHealth(supabase);
    lastWebhookAt = webhookHealth.last_webhook_at;
    webhookHealthy = webhookHealth.healthy;
  }

  if (!apiKeysConfigured) {
    return buildSnapshot(role, providerId, config, {
      apiKeysConfigured: false,
      webhookConfigured,
      webhookHealthy,
      lastWebhookAt,
      status: "NOT_CONFIGURED",
      message: `Provider ${config.display_name} API keys are not configured`,
      configurationError: "Missing API secret key",
    });
  }

  if (!isCustomerBookingAdapterLive(providerId)) {
    const webhookStored = await hasWebhookSecretConfigured(supabase, providerId, environment);
    return buildSnapshot(role, providerId, config, {
      apiKeysConfigured: true,
      webhookConfigured: webhookStored,
      webhookHealthy: null,
      lastWebhookAt: null,
      status: "TEST_MODE",
      message:
        `${config.display_name} credentials stored. Live booking adapter not implemented (PROVIDER_NOT_IMPLEMENTED).`,
      configurationError: null,
    });
  }

  if (providerId === "stripe" && role === "customer" && webhookConfigured === false) {
    return buildSnapshot(role, providerId, config, {
      apiKeysConfigured: true,
      webhookConfigured: false,
      webhookHealthy,
      lastWebhookAt,
      status: "NOT_CONFIGURED",
      message: `Provider ${config.display_name} webhook secret is not configured`,
      configurationError: "Missing webhook secret",
    });
  }

  if (config.last_connection_test_status === "error" || config.status === "error") {
    return buildSnapshot(role, providerId, config, {
      apiKeysConfigured: true,
      webhookConfigured,
      webhookHealthy,
      lastWebhookAt,
      status: "CONNECTION_FAILED",
      message: config.last_error_message
        ?? `Provider ${config.display_name} connection test failed`,
      configurationError: config.last_error_message ?? "Connection test failed",
    });
  }

  if (providerId === "stripe" && webhookHealthy === false) {
    return buildSnapshot(role, providerId, config, {
      apiKeysConfigured: true,
      webhookConfigured,
      webhookHealthy: false,
      lastWebhookAt,
      status: "CONNECTION_FAILED",
      message: "Stripe webhook health check is failing",
      configurationError: "Webhook failing",
    });
  }

  const testMode = environment === "test"
    || secretLooksTestMode(apiKeysConfigured, providerId)
    || config.status === "test";

  if (testMode) {
    return buildSnapshot(role, providerId, config, {
      apiKeysConfigured: true,
      webhookConfigured,
      webhookHealthy,
      lastWebhookAt,
      status: "TEST_MODE",
      message: `${config.display_name} is configured in test mode`,
      configurationError: null,
    });
  }

  return buildSnapshot(role, providerId, config, {
    apiKeysConfigured: true,
    webhookConfigured,
    webhookHealthy,
    lastWebhookAt,
    status: "CONNECTED",
    message: `${config.display_name} is connected and ready`,
    configurationError: null,
  });
}

export async function resolveServiceAreaGatewayStatuses(
  supabase: SupabaseClient,
  serviceAreaId: string,
): Promise<{
  service_area_id: string;
  customer: GatewayStatusSnapshot;
  driver: GatewayStatusSnapshot;
  currency_code: string | null;
  region_name: string | null;
}> {
  const { data: area } = await supabase
    .from("service_areas")
    .select(
      "id, customer_payment_gateway, driver_payout_gateway, regions!inner(name, currency_code)",
    )
    .eq("id", serviceAreaId)
    .maybeSingle();

  if (!area) {
    const missingCustomer = await resolveProviderGatewayStatus(supabase, null, "customer");
    const missingDriver = await resolveProviderGatewayStatus(supabase, null, "driver");
    return {
      service_area_id: serviceAreaId,
      customer: missingCustomer,
      driver: missingDriver,
      currency_code: null,
      region_name: null,
    };
  }

  const region = area.regions as { name?: string; currency_code?: string } | null;
  const [customer, driver] = await Promise.all([
    resolveProviderGatewayStatus(supabase, area.customer_payment_gateway as string | null, "customer"),
    resolveProviderGatewayStatus(supabase, area.driver_payout_gateway as string | null, "driver"),
  ]);

  return {
    service_area_id: area.id as string,
    customer,
    driver,
    currency_code: region?.currency_code ?? null,
    region_name: region?.name ?? null,
  };
}

export type ServiceAreaGatewayFinanceRow = {
  service_area_id: string;
  service_area_name: string | null;
  region_name: string | null;
  currency_code: string | null;
  customer: GatewayStatusSnapshot;
  driver: GatewayStatusSnapshot;
  last_successful_payment_at: string | null;
  last_successful_payout_at: string | null;
};

async function loadLastSuccessfulPaymentAt(
  supabase: SupabaseClient,
  serviceAreaId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("trips")
    .select("completed_at")
    .eq("service_area_id", serviceAreaId)
    .in("payment_status", ["captured", "paid", "succeeded"])
    .not("completed_at", "is", null)
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.completed_at as string | null) ?? null;
}

async function loadLastSuccessfulPayoutAt(
  supabase: SupabaseClient,
  serviceAreaId: string,
): Promise<string | null> {
  const { data: trips } = await supabase
    .from("trips")
    .select("id")
    .eq("service_area_id", serviceAreaId)
    .limit(2000);
  const tripIds = (trips ?? []).map((t) => t.id as string).filter(Boolean);
  if (tripIds.length === 0) return null;

  const { data: payout } = await supabase
    .from("payout_items")
    .select("updated_at, created_at")
    .in("trip_id", tripIds)
    .in("status", ["paid", "succeeded", "completed"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (payout?.updated_at as string | null) ??
    (payout?.created_at as string | null) ??
    null;
}

/** All service areas in scope — Financial Reconciliation + admin dashboards. */
export async function resolveAllServiceAreaGatewayStatuses(
  supabase: SupabaseClient,
  filter?: { regionId?: string | null; serviceAreaId?: string | null },
): Promise<ServiceAreaGatewayFinanceRow[]> {
  let query = supabase
    .from("service_areas")
    .select(
      "id, name, customer_payment_gateway, driver_payout_gateway, regions!inner(name, currency_code)",
    )
    .eq("is_active", true)
    .order("name");

  if (filter?.serviceAreaId) {
    query = query.eq("id", filter.serviceAreaId);
  } else if (filter?.regionId) {
    query = query.eq("region_id", filter.regionId);
  }

  const { data: areas, error } = await query;
  if (error) throw error;
  if (!areas?.length) return [];

  return Promise.all(
    areas.map(async (area) => {
      const region = area.regions as { name?: string; currency_code?: string } | null;
      const serviceAreaId = area.id as string;
      const [customer, driver, lastPayment, lastPayout] = await Promise.all([
        resolveProviderGatewayStatus(
          supabase,
          area.customer_payment_gateway as string | null,
          "customer",
        ),
        resolveProviderGatewayStatus(
          supabase,
          area.driver_payout_gateway as string | null,
          "driver",
        ),
        loadLastSuccessfulPaymentAt(supabase, serviceAreaId),
        loadLastSuccessfulPayoutAt(supabase, serviceAreaId),
      ]);

      return {
        service_area_id: serviceAreaId,
        service_area_name: (area.name as string | null) ?? null,
        region_name: region?.name ?? null,
        currency_code: region?.currency_code ?? null,
        customer,
        driver,
        last_successful_payment_at: lastPayment,
        last_successful_payout_at: lastPayout,
      };
    }),
  );
}

export function gatewayStatusToPaymentGatewayPayload(
  snapshot: GatewayStatusSnapshot,
  fallbackProvider: string | null,
): Record<string, unknown> {
  return {
    provider: snapshot.provider ?? fallbackProvider,
    display_name: snapshot.display_name,
    environment: snapshot.environment,
    configured: snapshot.configured,
    ready_for_production: snapshot.ready_for_production,
    status: snapshot.status,
    badge_label: snapshot.badge_label,
    badge_emoji: snapshot.badge_emoji,
    message: snapshot.message,
    configuration_error: snapshot.configuration_error,
    code: snapshot.ready_for_production
      ? null
      : snapshot.status === "NOT_CONFIGURED"
      ? "PAYMENT_GATEWAY_NOT_CONFIGURED"
      : snapshot.status,
    health: snapshot.health,
  };
}
