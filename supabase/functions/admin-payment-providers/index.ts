import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  detectModeMismatch,
  getPaymentProviderAdapter,
  maskSecretValue,
  SUPPORTED_PAYMENT_PROVIDER_IDS,
  PROVIDER_SECRET_FIELDS,
  type PaymentProviderId,
  type ProviderEnvironment,
  type ProviderSecrets,
} from "../_shared/paymentProviders/index.ts";
import { loadPaymentProviderCredentialReadiness } from "../_shared/paymentProviderReadinessSSOT.ts";

const LIVE_CUSTOMER_BOOKING_PROVIDERS = new Set<string>(["revolut"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

async function requireAdmin(req: Request, supabase: ReturnType<typeof createClient>) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return { error: "Unauthorized", status: 401, user: null };

  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return { error: "Unauthorized", status: 401, user: null };

  const { data: roleData } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .maybeSingle();

  if (!roleData) return { error: "Admin access required", status: 403, user: null };
  return { error: null, status: 200, user };
}




async function buildProviderCard(
  supabase: ReturnType<typeof createClient>,
  config: Record<string, unknown>,
) {
  const provider = config.provider as PaymentProviderId;
  const environment = (config.environment as ProviderEnvironment) ?? "live";

  const credentialReadiness = await loadPaymentProviderCredentialReadiness(
    supabase,
    provider,
    environment,
  );
  const secrets = credentialReadiness.secrets;
  const statuses = {
    api_key: credentialReadiness.api_key_status,
    webhook: credentialReadiness.webhook_secret_status,
  };
  const modeMismatch = detectModeMismatch(environment, secrets.secret_key);
  const adapterLive = credentialReadiness.booking_adapter_live;
  const payoutAdapterLive = credentialReadiness.payout_adapter_live;
  const credentialsReady = credentialReadiness.credentials_ready;
  let customerGateway;
  let driverGateway;
  try {
    const { resolveProviderGatewayStatus } = await import("../_shared/paymentGatewayStatus.ts");
    [customerGateway, driverGateway] = await Promise.all([
      resolveProviderGatewayStatus(supabase, provider, "customer"),
      resolveProviderGatewayStatus(supabase, provider, "driver"),
    ]);
  } catch (gatewayErr) {
    console.error("buildProviderCard gateway status failed", provider, gatewayErr);
    customerGateway = {
      ready_for_production: false,
      status: "CONNECTION_FAILED",
      configuration_error: (gatewayErr as Error)?.message ?? "Gateway status check failed",
      booking_workflow: "blocked",
    };
    driverGateway = customerGateway;
  }

  const { data: metadataRows } = await supabase
    .from("payment_provider_secret_metadata")
    .select("secret_name, masked_value, is_configured, last_updated, updated_by")
    .eq("provider", provider)
    .eq("environment", environment);

  const masks: Record<string, string | null> = {};
  const fieldNames = PROVIDER_SECRET_FIELDS[provider] ?? [];
  for (const name of fieldNames) {
    const meta = metadataRows?.find((m) => m.secret_name === name);
    if (meta?.masked_value) {
      masks[name] = meta.masked_value;
    } else if (secrets[name]) {
      masks[name] = maskSecretValue(secrets[name]!);
    } else {
      masks[name] = null;
    }
  }

  let derivedStatus = config.status as string;
  if (!credentialsReady) {
    derivedStatus = "not_configured";
  } else if (!adapterLive) {
    derivedStatus = "connected";
  } else if (secrets.secret_key?.includes("_test_")) {
    derivedStatus = "test";
  } else if (secrets.secret_key?.includes("_live_")) {
    derivedStatus = "live";
  } else if (derivedStatus === "not_configured") {
    derivedStatus = "connected";
  }

  const webhookStatus: "healthy" | "failing" | "not_configured" = "not_configured";
  const webhookHealth = null;
  const connectEnabled = config.connect_enabled as boolean | null;
  const applePayEnabled = config.apple_pay_enabled as boolean | null;
  const googlePayEnabled = config.google_pay_enabled as boolean | null;

  const warnings: string[] = [];
  if (modeMismatch) warnings.push(modeMismatch);
  if (!adapterLive && credentialsReady) {
    warnings.push(
      "Credentials stored. Booking adapter PROVIDER_NOT_IMPLEMENTED — provider is not live for customer bookings until adapter, webhook processing, sandbox test, and production approval.",
    );
  }
  if (!credentialsReady) {
    warnings.push("Add API keys when vendor credentials are available.");
  } else if (!adapterLive && statuses.webhook === "missing") {
    warnings.push("Webhook secret not stored yet (optional until webhook processor is built).");
  }


  const bookingAdapterStatus = credentialReadiness.booking_adapter_status;
  const payoutAdapterStatus = credentialReadiness.payout_adapter_status;

  return {
    provider,
    display_name: config.display_name,
    status: derivedStatus,
    mode: environment,
    is_enabled: config.is_enabled,
    is_primary: config.is_primary,
    api_key_status: statuses.api_key,
    webhook_status: webhookStatus,
    webhook_secret_status: statuses.webhook,
    credentials_ready: credentialsReady,
    booking_adapter_live: adapterLive,
    booking_adapter_status: bookingAdapterStatus,
    payout_adapter_live: payoutAdapterLive,
    payout_adapter_status: payoutAdapterStatus,
    ready_for_production: customerGateway.ready_for_production,
    booking_workflow: customerGateway.booking_workflow,
    customer_gateway_status: customerGateway.status,
    driver_gateway_status: driverGateway.status,
    configuration_error: customerGateway.configuration_error,
    last_webhook_received: webhookHealth?.last_received_at ?? null,
    last_successful_event: webhookHealth?.last_successful_event ?? null,
    last_failed_event: webhookHealth?.last_failed_event ?? null,
    connect_enabled: connectEnabled,
    apple_pay_enabled: applePayEnabled,
    google_pay_enabled: googlePayEnabled,
    webhook_endpoint_url: config.webhook_endpoint_url ?? null,
    secrets: {
      publishable_key: masks.publishable_key ?? null,
      secret_key: masks.secret_key ?? null,
      webhook_secret: masks.webhook_secret ?? null,
      merchant_id: masks.merchant_id ?? null,
    },
    secret_metadata: metadataRows ?? [],
    webhook_health: webhookHealth,
    warnings,
    last_connection_test_at: config.last_connection_test_at,
    last_error_message: config.last_error_message,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const auth = await requireAdmin(req, supabase);
    if (!auth.user) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: auth.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    if (req.method === "GET" && action === "service-area-gateways") {
      const serviceAreaId = url.searchParams.get("service_area_id");
      if (!serviceAreaId) {
        return new Response(JSON.stringify({ error: "service_area_id is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      try {
        const { resolveServiceAreaGatewayStatuses } = await import(
          "../_shared/paymentGatewayStatus.ts"
        );
        const statuses = await resolveServiceAreaGatewayStatuses(supabase, serviceAreaId);

        return new Response(JSON.stringify({ success: true, ...statuses }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (gatewayErr) {
        console.error("service-area-gateways failed", gatewayErr);
        return new Response(
          JSON.stringify({
            success: false,
            error: (gatewayErr as Error)?.message ?? "service_area_gateway_status_failed",
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    if (req.method === "GET") {
      const { data: configs, error } = await supabase
        .from("payment_provider_configs")
        .select("*")
        .order("is_primary", { ascending: false });

      if (error) throw error;

      const providers = await Promise.all(
        (configs ?? [])
          .filter((c) => SUPPORTED_PAYMENT_PROVIDER_IDS.includes(c.provider as PaymentProviderId))
          .map((c) => buildProviderCard(supabase, c)),
      );

      const active = providers.find((p) => p.is_primary && p.is_enabled)
        ?? providers.find((p) => p.is_enabled && p.provider === "revolut")
        ?? null;

      return new Response(
        JSON.stringify({
          active_provider: active?.provider ?? "unavailable",
          providers,
          global_warnings: providers.flatMap((p) => p.warnings),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (req.method === "POST" && action === "test-connection") {
      const body = await req.json();
      const provider = body.provider as PaymentProviderId;
      const environment = (body.environment as ProviderEnvironment) ?? "live";

      const adapter = getPaymentProviderAdapter(supabase, provider, environment, {
        updatedBy: auth.user.id,
      });
      const result = await adapter.testConnection();

      const adapterLive = LIVE_CUSTOMER_BOOKING_PROVIDERS.has(provider);
      const nextStatus = !result.ok
        ? "error"
        : !adapterLive
        ? "connected"
        : result.mode === "test"
        ? "test"
        : result.mode === "live"
        ? "live"
        : "connected";

      await supabase
        .from("payment_provider_configs")
        .update({
          last_connection_test_at: new Date().toISOString(),
          last_connection_test_status: result.ok ? "ok" : "error",
          last_error_message: result.ok ? null : result.message,
          status: nextStatus,
        })
        .eq("provider", provider);

      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (req.method === "POST" && action === "save-secrets") {
      const body = await req.json();
      const provider = body.provider as PaymentProviderId;
      const environment = (body.environment as ProviderEnvironment) ?? "live";
      const secrets = body.secrets as Partial<ProviderSecrets>;

      const { upsertProviderSecret } = await import("../_shared/paymentProviders/secretManager.ts");

      for (const name of PROVIDER_SECRET_FIELDS[provider]) {
        const value = secrets[name];
        if (value && value.trim()) {
          await upsertProviderSecret(supabase, {
            provider,
            environment,
            secretName: name,
            secretValue: value.trim(),
            updatedBy: auth.user.id,
          });
        }
      }

      const card = await buildProviderCard(
        supabase,
        (await supabase.from("payment_provider_configs").select("*").eq("provider", provider).single()).data!,
      );

      return new Response(JSON.stringify({ ok: true, provider: card }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (req.method === "PATCH") {
      const body = await req.json();
      const provider = body.provider as PaymentProviderId;
      if (!provider) {
        return new Response(JSON.stringify({ error: "provider is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const updates: Record<string, unknown> = {};
      if (typeof body.is_enabled === "boolean") updates.is_enabled = body.is_enabled;
      if (typeof body.is_primary === "boolean") updates.is_primary = body.is_primary;
      if (typeof body.environment === "string") updates.environment = body.environment;
      if (typeof body.connect_enabled === "boolean") updates.connect_enabled = body.connect_enabled;
      if (typeof body.apple_pay_enabled === "boolean") updates.apple_pay_enabled = body.apple_pay_enabled;
      if (typeof body.google_pay_enabled === "boolean") updates.google_pay_enabled = body.google_pay_enabled;

      if (body.is_primary === true) {
        await supabase
          .from("payment_provider_configs")
          .update({ is_primary: false })
          .neq("provider", provider);
      }

      const { data, error } = await supabase
        .from("payment_provider_configs")
        .update(updates)
        .eq("provider", provider)
        .select("*")
        .single();

      if (error) throw error;

      const card = await buildProviderCard(supabase, data);
      return new Response(JSON.stringify({ ok: true, provider: card }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("admin-payment-providers error:", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
