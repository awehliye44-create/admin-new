/**
 * Payment gateway operational status — backend SSOT.
 * Dropdown selection ≠ operational status. Never infer from provider row alone.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  type AdapterReadinessStatus,
  loadPaymentProviderCredentialReadiness,
  resolveProviderBookingWorkflow,
  type ProviderBookingWorkflow,
  verifyLiveProviderApiAuthentication,
} from "./paymentProviderReadinessSSOT.ts";
import type { PaymentProviderId, ProviderEnvironment } from "./paymentProviders/types.ts";

/** Defined here to avoid circular imports with paymentGatewayGuard / customerPaymentWorkflow. */
export type GatewayRole = "customer" | "driver";

/** Live adapters only — credentials alone do not make a provider production-ready. */
const LIVE_PAYMENT_ADAPTERS = new Set<string>(["revolut"]);

function isLivePaymentAdapter(provider: string | null | undefined): boolean {
  return Boolean(provider && LIVE_PAYMENT_ADAPTERS.has(provider));
}

/** Machine-readable block when a service-area gateway is not bookable. */
export type GatewayBlockCode = "PAYMENT_GATEWAY_NOT_CONFIGURED" | "PROVIDER_NOT_IMPLEMENTED";

/** Map operational status → booking block code (no provider fallback). */
export function resolveGatewayBlockCode(snapshot: GatewayStatusSnapshot): GatewayBlockCode {
  if (
    !snapshot.provider
    || snapshot.status === "NOT_CONFIGURED"
    || snapshot.status === "DISABLED"
  ) {
    return "PAYMENT_GATEWAY_NOT_CONFIGURED";
  }
  if (!isLivePaymentAdapter(snapshot.provider)) {
    return "PROVIDER_NOT_IMPLEMENTED";
  }
  if (!snapshot.ready_for_production) {
    return snapshot.status === "TEST_MODE"
      ? "PROVIDER_NOT_IMPLEMENTED"
      : "PAYMENT_GATEWAY_NOT_CONFIGURED";
  }
  return "PAYMENT_GATEWAY_NOT_CONFIGURED";
}

export type PaymentGatewayStatusCode =
  | "CONNECTED"
  | "NOT_CONFIGURED"
  | "DISABLED"
  | "CONNECTION_FAILED"
  | "TEST_MODE";

/** Booking must use booking_payment_health, not generic provider_health. */
export type BookingPaymentHealth = "healthy" | "degraded" | "down";
export type ProviderHealthTier = "healthy" | "degraded" | "down";

export type GatewayStatusSnapshot = {
  status: PaymentGatewayStatusCode;
  badge_label: string;
  badge_emoji: string;
  provider: string | null;
  display_name: string | null;
  role: GatewayRole;
  environment: "test" | "live" | null;
  configured: boolean;
  /** True when card booking may proceed (API keys + live adapter; webhook warnings do not block). */
  ready_for_production: boolean;
  message: string | null;
  configuration_error: string | null;
  /** Admin-facing overall provider health (may be degraded while booking still allowed). */
  provider_health: ProviderHealthTier;
  /** Customer booking gate — only "down" blocks bookings. */
  booking_payment_health: BookingPaymentHealth;
  /** SSOT adapter readiness — same object Settings → Payment Providers uses. */
  booking_adapter_status: AdapterReadinessStatus;
  payout_adapter_status: AdapterReadinessStatus;
  booking_workflow: ProviderBookingWorkflow;
  credentials_ready: boolean;
  api_key_status: "added" | "missing";
  webhook_secret_status: "added" | "missing";
  health: {
    api_keys_configured: boolean;
    webhook_configured: boolean | null;
    webhook_healthy: boolean | null;
    /** Provider credentials present and live auth probe not in error. */
    provider_api_health: BookingPaymentHealth | null;
    /** @deprecated Legacy alias of provider_api_health for older consumers. */
    stripe_api_health: BookingPaymentHealth | null;
    /** Whether webhooks are being delivered/received recently. */
    webhook_delivery_health: BookingPaymentHealth | null;
    /** Handler/processing outcome (internal errors ≠ provider outage). */
    webhook_processing_health: BookingPaymentHealth | null;
    enabled: boolean;
    supports_role: boolean;
    last_connection_test_at: string | null;
    last_connection_test_status: string | null;
    last_error_message: string | null;
    last_webhook_at: string | null;
    last_webhook_error: string | null;
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

async function loadProviderCredentials(
  supabase: SupabaseClient,
  provider: string,
  environment: string,
) {
  return loadPaymentProviderCredentialReadiness(
    supabase,
    provider as PaymentProviderId,
    (environment === "test" ? "test" : "live") as ProviderEnvironment,
  );
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
    lastWebhookError?: string | null;
    providerApiHealth?: BookingPaymentHealth | null;
    webhookDeliveryHealth?: BookingPaymentHealth | null;
    webhookProcessingHealth?: BookingPaymentHealth | null;
    bookingPaymentHealth?: BookingPaymentHealth;
    providerHealth?: ProviderHealthTier;
    status: PaymentGatewayStatusCode;
    message: string;
    configurationError: string | null;
    credentialReadiness?: Awaited<ReturnType<typeof loadPaymentProviderCredentialReadiness>>;
  },
): GatewayStatusSnapshot {
  const badge = gatewayStatusBadge(args.status);
  const environment = config
    ? ((config.environment === "test" ? "test" : "live") as "test" | "live")
    : null;

  const bookingPaymentHealth: BookingPaymentHealth = args.bookingPaymentHealth
    ?? (args.status === "CONNECTED" || args.status === "TEST_MODE"
      ? "healthy"
      : "down");
  const providerHealth: ProviderHealthTier = args.providerHealth
    ?? (bookingPaymentHealth === "down"
      ? "down"
      : args.webhookHealthy === false
        ? "degraded"
        : "healthy");

  const credentialReadiness = args.credentialReadiness;
  const collectionAdapterLive =
    Boolean(providerId && isLivePaymentAdapter(providerId))
    && bookingPaymentHealth !== "down"
    && (credentialReadiness?.booking_adapter_status === "live"
      || (credentialReadiness?.credentials_ready && args.apiKeysConfigured));
  const payoutAdapterLive =
    credentialReadiness?.payout_adapter_status === "live";
  const readyForProduction = role === "customer"
    ? collectionAdapterLive
    : Boolean(
      providerId
        && bookingPaymentHealth !== "down"
        && payoutAdapterLive,
    );

  return {
    status: args.status,
    badge_label: badge.label,
    badge_emoji: badge.emoji,
    provider: providerId,
    display_name: config?.display_name ?? null,
    role,
    environment,
    configured: args.apiKeysConfigured,
    // Booking depends on payment API readiness, not webhook processing warnings.
    ready_for_production: readyForProduction,
    message: args.message,
    configuration_error: args.configurationError,
    provider_health: providerHealth,
    booking_payment_health: bookingPaymentHealth,
    booking_adapter_status: credentialReadiness?.booking_adapter_status
      ?? (collectionAdapterLive ? "live" : "not_configured"),
    payout_adapter_status: credentialReadiness?.payout_adapter_status ?? "not_configured",
    booking_workflow: resolveProviderBookingWorkflow(providerId, readyForProduction),
    credentials_ready: credentialReadiness?.credentials_ready ?? args.apiKeysConfigured,
    api_key_status: credentialReadiness?.api_key_status
      ?? (args.apiKeysConfigured ? "added" : "missing"),
    webhook_secret_status: credentialReadiness?.webhook_secret_status ?? "missing",
    health: {
      api_keys_configured: args.apiKeysConfigured,
      webhook_configured: args.webhookConfigured,
      webhook_healthy: args.webhookHealthy,
      provider_api_health: args.providerApiHealth ?? null,
      stripe_api_health: args.providerApiHealth ?? null,
      webhook_delivery_health: args.webhookDeliveryHealth ?? null,
      webhook_processing_health: args.webhookProcessingHealth ?? null,
      enabled: config?.is_enabled === true,
      supports_role: config ? supportsRole(config, role) : false,
      last_connection_test_at: config?.last_connection_test_at ?? null,
      last_connection_test_status: config?.last_connection_test_status ?? null,
      last_error_message: config?.last_error_message ?? null,
      last_webhook_at: args.lastWebhookAt,
      last_webhook_error: args.lastWebhookError ?? null,
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
  const credentialReadiness = await loadProviderCredentials(supabase, providerId, environment);
  const apiKeysConfigured = credentialReadiness.credentials_ready;
  const webhookStored = credentialReadiness.webhook_secret_status === "added";

  const webhookConfigured: boolean | null = webhookStored;
  const webhookHealthy: boolean | null = null;
  const lastWebhookAt: string | null = null;
  const lastWebhookError: string | null = null;
  const webhookDeliveryHealth: BookingPaymentHealth | null = null;
  const webhookProcessingHealth: BookingPaymentHealth | null = null;

  const withCredentials = (extra: Parameters<typeof buildSnapshot>[3]) => ({
    ...extra,
    credentialReadiness,
  });

  if (!apiKeysConfigured) {
    return buildSnapshot(role, providerId, config, withCredentials({
      apiKeysConfigured: false,
      webhookConfigured,
      webhookHealthy,
      lastWebhookAt,
      lastWebhookError,
      providerApiHealth: "down",
      webhookDeliveryHealth,
      webhookProcessingHealth,
      bookingPaymentHealth: "down",
      providerHealth: "down",
      status: "NOT_CONFIGURED",
      message: `Provider ${config.display_name} API keys are not configured`,
      configurationError: "Missing API secret key",
    }));
  }

  if (!isLivePaymentAdapter(providerId)) {
    const notImplementedMessage = role === "driver"
      ? `${config.display_name} payout setup is not available yet.`
      : `${config.display_name} credentials stored. Live booking adapter not implemented (PROVIDER_NOT_IMPLEMENTED).`;
    return buildSnapshot(role, providerId, config, withCredentials({
      apiKeysConfigured: true,
      webhookConfigured: webhookStored,
      webhookHealthy: null,
      lastWebhookAt: null,
      providerApiHealth: "healthy",
      bookingPaymentHealth: "down",
      providerHealth: "down",
      status: "TEST_MODE",
      message: notImplementedMessage,
      configurationError: null,
    }));
  }

  const liveAuth = await verifyLiveProviderApiAuthentication(
    supabase,
    providerId as PaymentProviderId,
    environment,
    config,
  );
  if (!liveAuth.ok) {
    const authMessage = liveAuth.message ?? "Live provider API authentication failed";
    return buildSnapshot(role, providerId, config, withCredentials({
      apiKeysConfigured: true,
      webhookConfigured: webhookStored,
      webhookHealthy,
      lastWebhookAt,
      lastWebhookError,
      providerApiHealth: "down",
      webhookDeliveryHealth,
      webhookProcessingHealth,
      bookingPaymentHealth: "down",
      providerHealth: "down",
      status: "CONNECTION_FAILED",
      message: authMessage,
      configurationError: authMessage,
    }));
  }

  const providerApiHealth: BookingPaymentHealth = "healthy";

  const testMode = environment === "test" || config.status === "test";

  if (testMode) {
    return buildSnapshot(role, providerId, config, withCredentials({
      apiKeysConfigured: true,
      webhookConfigured,
      webhookHealthy,
      lastWebhookAt,
      lastWebhookError,
      providerApiHealth,
      webhookDeliveryHealth,
      webhookProcessingHealth,
      bookingPaymentHealth: "healthy",
      providerHealth: "healthy",
      status: "TEST_MODE",
      message: `${config.display_name} is configured in test mode`,
      configurationError: null,
    }));
  }

  return buildSnapshot(role, providerId, config, withCredentials({
    apiKeysConfigured: true,
    webhookConfigured,
    webhookHealthy,
    lastWebhookAt,
    lastWebhookError,
    providerApiHealth,
    webhookDeliveryHealth,
    webhookProcessingHealth,
    bookingPaymentHealth: "healthy",
    providerHealth: "healthy",
    status: "CONNECTED",
    message: role === "driver" && providerId === "revolut" && credentialReadiness?.payout_adapter_status !== "live"
      ? `${config.display_name} customer collection connected; manual payout ready — automated payout not configured (add Source Business account ID).`
      : role === "driver" && credentialReadiness?.payout_adapter_status !== "live"
      ? `${config.display_name} connected; manual payout ready — automated payout not configured.`
      : `${config.display_name} is connected and ready`,
    configurationError: role === "driver" && credentialReadiness?.payout_adapter_status !== "live"
      ? "Automated payout not configured"
      : null,
  }));
}

/** Admin-selected primary provider — sole SSOT for collection + payout. */
function resolveAreaPaymentProvider(area: {
  payment_provider?: string | null;
}): string | null {
  return (area.payment_provider as string | null) ?? null;
}

export async function resolveServiceAreaGatewayStatuses(
  supabase: SupabaseClient,
  serviceAreaId: string,
): Promise<{
  service_area_id: string;
  payment_provider: string | null;
  customer: GatewayStatusSnapshot;
  driver: GatewayStatusSnapshot;
  currency_code: string | null;
  region_name: string | null;
}> {
  const { data: area } = await supabase
    .from("service_areas")
    .select(
      "id, payment_provider, customer_payment_gateway, driver_payout_gateway, regions!inner(name, currency_code)",
    )
    .eq("id", serviceAreaId)
    .maybeSingle();

  if (!area) {
    const missingCustomer = await resolveProviderGatewayStatus(supabase, null, "customer");
    const missingDriver = await resolveProviderGatewayStatus(supabase, null, "driver");
    return {
      service_area_id: serviceAreaId,
      payment_provider: null,
      customer: missingCustomer,
      driver: missingDriver,
      currency_code: null,
      region_name: null,
    };
  }

  const region = area.regions as { name?: string; currency_code?: string } | null;
  const provider = resolveAreaPaymentProvider(area);
  // Same provider for collection and payout.
  const [customer, driver] = await Promise.all([
    resolveProviderGatewayStatus(supabase, provider, "customer"),
    resolveProviderGatewayStatus(supabase, provider, "driver"),
  ]);

  return {
    service_area_id: area.id as string,
    payment_provider: provider,
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
  payment_provider: string | null;
  payment_gateway: GatewayStatusSnapshot;
  payout_gateway: GatewayStatusSnapshot;
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
      "id, name, payment_provider, customer_payment_gateway, driver_payout_gateway, regions!inner(name, currency_code)",
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
      const provider = resolveAreaPaymentProvider(area);
      const [customer, driver, lastPayment, lastPayout] = await Promise.all([
        resolveProviderGatewayStatus(supabase, provider, "customer"),
        resolveProviderGatewayStatus(supabase, provider, "driver"),
        loadLastSuccessfulPaymentAt(supabase, serviceAreaId),
        loadLastSuccessfulPayoutAt(supabase, serviceAreaId),
      ]);

      return {
        service_area_id: serviceAreaId,
        service_area_name: (area.name as string | null) ?? null,
        region_name: region?.name ?? null,
        currency_code: region?.currency_code ?? null,
        payment_provider: provider,
        payment_gateway: customer,
        payout_gateway: driver,
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
    booking_adapter_status: snapshot.booking_adapter_status,
    payout_adapter_status: snapshot.payout_adapter_status,
    booking_workflow: snapshot.booking_workflow,
    credentials_ready: snapshot.credentials_ready,
    api_key_status: snapshot.api_key_status,
    webhook_secret_status: snapshot.webhook_secret_status,
    /** Customer booking gate — only "down" blocks bookings. */
    booking_payment_health: snapshot.booking_payment_health,
    /** Admin overall health (may be degraded while booking still allowed). */
    provider_health: snapshot.provider_health,
    status: snapshot.status,
    badge_label: snapshot.badge_label,
    badge_emoji: snapshot.badge_emoji,
    message: snapshot.message,
    configuration_error: snapshot.configuration_error,
    code: snapshot.ready_for_production
      ? null
      : snapshot.status === "NOT_CONFIGURED" || snapshot.status === "DISABLED"
      ? "PAYMENT_GATEWAY_NOT_CONFIGURED"
      : !isLivePaymentAdapter(snapshot.provider)
      ? "PROVIDER_NOT_IMPLEMENTED"
      : snapshot.status,
    health: snapshot.health,
  };
}
