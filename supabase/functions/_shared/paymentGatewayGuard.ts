/**
 * Read-only payment gateway guard — no Stripe API calls.
 *
 * One service area = one admin-selected primary payment provider (`payment_provider`).
 * No dynamic routing, no automatic fallback, no backup switching.
 * Global provider credentials do not activate bookings — only service-area selection does.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  gatewayStatusToPaymentGatewayPayload,
  resolveGatewayBlockCode,
  resolveProviderGatewayStatus,
  type GatewayRole,
  type GatewayStatusSnapshot,
} from "./paymentGatewayStatus.ts";

export const PAYMENT_GATEWAY_NOT_CONFIGURED = "PAYMENT_GATEWAY_NOT_CONFIGURED";
export const PROVIDER_NOT_IMPLEMENTED = "PROVIDER_NOT_IMPLEMENTED";

export type { GatewayRole };

export type ServiceAreaGatewayResolution = {
  service_area_id: string;
  /** Single provider for collection + payout. */
  payment_provider: string | null;
  /** Mirror of payment_provider (compat). */
  customer_payment_gateway: string | null;
  /** Mirror of payment_provider (compat). */
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
  code: typeof PAYMENT_GATEWAY_NOT_CONFIGURED | typeof PROVIDER_NOT_IMPLEMENTED;
  role: GatewayRole;
  provider: string | null;
  reason: string;
};

export type GatewayCheckResult = GatewayConfiguredResult | GatewayNotConfiguredResult;

export type { GatewayStatusSnapshot, PaymentGatewayStatusCode } from "./paymentGatewayStatus.ts";
export {
  gatewayStatusBadge,
  gatewayStatusToPaymentGatewayPayload,
  resolveProviderGatewayStatus,
  resolveServiceAreaGatewayStatuses,
  resolveAllServiceAreaGatewayStatuses,
} from "./paymentGatewayStatus.ts";

/** Admin-selected primary provider — sole SSOT (mirrors are not read). */
export function resolveServiceAreaPaymentProvider(row: {
  payment_provider?: string | null;
} | null | undefined): string | null {
  if (!row) return null;
  return (row.payment_provider as string | null) ?? null;
}

export async function loadServiceAreaGateways(
  supabase: SupabaseClient,
  serviceAreaId: string,
): Promise<ServiceAreaGatewayResolution | null> {
  const { data, error } = await supabase
    .from("service_areas")
    .select("id, payment_provider, customer_payment_gateway, driver_payout_gateway")
    .eq("id", serviceAreaId)
    .maybeSingle();

  if (error || !data) return null;

  const provider = resolveServiceAreaPaymentProvider(data);

  return {
    service_area_id: data.id as string,
    payment_provider: provider,
    customer_payment_gateway: provider,
    driver_payout_gateway: provider,
  };
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

  // Single provider for both customer collection and driver payout.
  const providerId = gateways.payment_provider;

  const status = await resolveProviderGatewayStatus(supabase, providerId, role);
  if (!status.ready_for_production) {
    const code = resolveGatewayBlockCode(status);
    return {
      ok: false,
      code,
      role,
      provider: status.provider,
      reason: status.message ?? status.configuration_error ?? "Payment gateway not configured",
    };
  }

  return {
    ok: true,
    provider: status.provider!,
    environment: status.environment ?? "live",
    display_name: status.display_name ?? status.provider!,
    role,
  };
}

/** Customer booking edges: only live adapters execute — never fall back to Stripe. */
export function assertGatewayExecutable(check: GatewayCheckResult): GatewayCheckResult {
  if (!check.ok) return check;
  if (check.provider !== "stripe") {
    return {
      ok: false,
      code: PROVIDER_NOT_IMPLEMENTED,
      role: check.role,
      provider: check.provider,
      reason: `${check.display_name} is registered but not yet enabled for live booking`,
    };
  }
  return check;
}

/** Stripe Connect edges: only when service area driver payout gateway is Stripe. */
export function assertStripeDriverPayoutGateway(check: GatewayCheckResult): GatewayCheckResult {
  if (!check.ok) return check;
  if (check.provider !== "stripe") {
    return {
      ok: false,
      code: PAYMENT_GATEWAY_NOT_CONFIGURED,
      role: check.role,
      provider: check.provider,
      reason: "Stripe Connect is not the payout gateway for this service area",
    };
  }
  return check;
}

/** Non-Stripe destination edges: block Stripe service areas. */
export function assertNonStripeDriverPayoutGateway(check: GatewayCheckResult): GatewayCheckResult {
  if (!check.ok) return check;
  if (check.provider === "stripe") {
    return {
      ok: false,
      code: PAYMENT_GATEWAY_NOT_CONFIGURED,
      role: check.role,
      provider: check.provider,
      reason: "Use Manage Stripe Account for Stripe Connect payouts",
    };
  }
  return check;
}

export function buildDriverPayoutGatewayPayload(
  status: GatewayStatusSnapshot,
  fallbackProvider: string | null,
): Record<string, unknown> {
  return gatewayStatusToPaymentGatewayPayload(status, fallbackProvider);
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
