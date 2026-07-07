/**
 * Admin — Digital payment methods per service area.
 * GET: readiness + toggles for Admin UI "Digital payment methods" section.
 * PATCH: update per-method toggles (card, saved_card, apple_pay, google_pay, mobile_wallet, pay_by_bank).
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, requireAdmin } from "../_shared/adminPaymentGate.ts";
import { checkServiceAreaGateway } from "../_shared/paymentGatewayGuard.ts";
import { buildServiceAreaPaymentMethodFlags } from "../_shared/customerPaymentWorkflow.ts";
import {
  buildDigitalPaymentMethodsPayload,
  parseServiceAreaPaymentMethodFlags,
} from "../_shared/paymentMethodSSOT.ts";
import {
  gatewayStatusToPaymentGatewayPayload,
  resolveProviderGatewayStatus,
} from "../_shared/paymentGatewayStatus.ts";
import { getProviderSecrets } from "../_shared/paymentProviders/secretManager.ts";
import type { ProviderEnvironment } from "../_shared/paymentProviders/types.ts";

const adminCorsHeaders = {
  ...corsHeaders,
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

const TOGGLE_FIELDS = [
  "card_enabled",
  "saved_card_enabled",
  "apple_pay_enabled",
  "google_pay_enabled",
  "mobile_wallet_enabled",
  "pay_by_bank_enabled",
  "wallet_enabled",
] as const;

type ToggleField = (typeof TOGGLE_FIELDS)[number];

function pickToggleUpdates(body: Record<string, unknown>): Partial<Record<ToggleField, boolean>> {
  const updates: Partial<Record<ToggleField, boolean>> = {};
  for (const field of TOGGLE_FIELDS) {
    if (typeof body[field] === "boolean") {
      updates[field] = body[field] as boolean;
    }
  }
  return updates;
}

async function buildAdminDigitalPaymentPayload(
  supabase: ReturnType<typeof createClient>,
  serviceAreaId: string,
) {
  const { data: area } = await supabase
    .from("service_areas")
    .select("id, payment_provider")
    .eq("id", serviceAreaId)
    .maybeSingle();

  if (!area) {
    return { error: "Service area not found", code: "SERVICE_AREA_NOT_FOUND" };
  }

  const paymentProvider = (area.payment_provider as string | null) ?? null;
  const [customerGatewayStatus, driverGatewayStatus, pmRes, customerGatewayCheck] =
    await Promise.all([
      resolveProviderGatewayStatus(supabase, paymentProvider, "customer"),
      resolveProviderGatewayStatus(supabase, paymentProvider, "driver"),
      supabase
        .from("service_area_payment_methods")
        .select("*")
        .eq("service_area_id", serviceAreaId)
        .maybeSingle(),
      checkServiceAreaGateway(supabase, serviceAreaId, "customer"),
    ]);

  const pm = pmRes.data as Record<string, unknown> | null;
  const methodFlags = buildServiceAreaPaymentMethodFlags(pm, customerGatewayCheck);
  const flags = parseServiceAreaPaymentMethodFlags(pm);

  let hasRevolutBusinessAccountId = false;
  if (paymentProvider === "revolut" && customerGatewayStatus.environment) {
    const secrets = await getProviderSecrets(
      supabase,
      "revolut",
      customerGatewayStatus.environment as ProviderEnvironment,
    );
    hasRevolutBusinessAccountId = Boolean(secrets.merchant_id?.trim());
  }

  return {
    service_area_id: serviceAreaId,
    payment_provider: paymentProvider,
    toggles: {
      card_enabled: flags.card,
      saved_card_enabled: flags.savedCard,
      apple_pay_enabled: flags.applePay,
      google_pay_enabled: flags.googlePay,
      mobile_wallet_enabled: flags.mobileWallet,
      pay_by_bank_enabled: flags.payByBank,
      wallet_enabled: flags.onecabWallet,
      mobile_wallet_methods: pm?.mobile_wallet_methods ?? null,
    },
    digital_payment_methods: buildDigitalPaymentMethodsPayload({
      flags,
      customerGateway: customerGatewayStatus,
      driverGateway: driverGatewayStatus,
      mobileWalletMethods: methodFlags.enabled_mobile_wallet_methods,
      hasRevolutBusinessAccountId,
    }),
    payment_gateways: {
      customer: gatewayStatusToPaymentGatewayPayload(customerGatewayStatus, paymentProvider),
      driver: gatewayStatusToPaymentGatewayPayload(driverGatewayStatus, paymentProvider),
    },
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: adminCorsHeaders });
  }

  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;

  const { supabase } = gate;
  const body = req.method === "GET"
    ? Object.fromEntries(new URL(req.url).searchParams.entries())
    : await req.json().catch(() => ({}));

  const serviceAreaId = String(body.service_area_id ?? "").trim();
  if (!serviceAreaId) {
    return new Response(
      JSON.stringify({ success: false, error: "service_area_id is required" }),
      { status: 400, headers: { ...adminCorsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (req.method === "PATCH" || (req.method === "POST" && (Object.keys(pickToggleUpdates(body as Record<string, unknown>)).length > 0 || (body as Record<string, unknown>).mobile_wallet_methods !== undefined))) {
    const updates = pickToggleUpdates(body as Record<string, unknown>);
    if (Object.keys(updates).length === 0 && body.mobile_wallet_methods === undefined) {
      return new Response(
        JSON.stringify({ success: false, error: "No payment method toggles provided" }),
        { status: 400, headers: { ...adminCorsHeaders, "Content-Type": "application/json" } },
      );
    }

    const patchBody: Record<string, unknown> = { ...updates };
    if (body.mobile_wallet_methods !== undefined) {
      patchBody.mobile_wallet_methods = body.mobile_wallet_methods;
    }

    const { data: existing } = await supabase
      .from("service_area_payment_methods")
      .select("id")
      .eq("service_area_id", serviceAreaId)
      .maybeSingle();

    if (existing?.id) {
      const { error } = await supabase
        .from("service_area_payment_methods")
        .update(patchBody)
        .eq("service_area_id", serviceAreaId);
      if (error) {
        return new Response(
          JSON.stringify({ success: false, error: error.message }),
          { status: 500, headers: { ...adminCorsHeaders, "Content-Type": "application/json" } },
        );
      }
    } else {
      const { error } = await supabase
        .from("service_area_payment_methods")
        .insert({
          service_area_id: serviceAreaId,
          card_enabled: updates.card_enabled ?? true,
          saved_card_enabled: updates.saved_card_enabled ?? true,
          wallet_enabled: updates.wallet_enabled ?? false,
          apple_pay_enabled: updates.apple_pay_enabled ?? false,
          google_pay_enabled: updates.google_pay_enabled ?? false,
          mobile_wallet_enabled: updates.mobile_wallet_enabled ?? false,
          pay_by_bank_enabled: updates.pay_by_bank_enabled ?? false,
          mobile_wallet_methods: body.mobile_wallet_methods ?? null,
        });
      if (error) {
        return new Response(
          JSON.stringify({ success: false, error: error.message }),
          { status: 500, headers: { ...adminCorsHeaders, "Content-Type": "application/json" } },
        );
      }
    }
  }

  const payload = await buildAdminDigitalPaymentPayload(supabase, serviceAreaId);
  if ("error" in payload) {
    return new Response(
      JSON.stringify({ success: false, error: payload.error, code: payload.code }),
      { status: 404, headers: { ...adminCorsHeaders, "Content-Type": "application/json" } },
    );
  }

  return new Response(JSON.stringify({ success: true, ...payload }), {
    status: 200,
    headers: { ...adminCorsHeaders, "Content-Type": "application/json" },
  });
});
