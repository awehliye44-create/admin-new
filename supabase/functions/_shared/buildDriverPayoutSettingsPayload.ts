/**
 * Build driver payout settings payload — backend SSOT for driver wallet payout UI.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { buildDriverPayoutGatewayPayload, checkServiceAreaGateway, resolveServiceAreaPaymentProvider } from "./paymentGatewayGuard.ts";
import { resolveProviderGatewayStatus } from "./paymentGatewayStatus.ts";
import { resolveDriverServiceAreaId } from "./resolveDriverServiceAreaId.ts";
import {
  buildMaskedDestinationLabel,
  supportedDestinationTypesForProvider,
  stripeConnectProviderStatus,
} from "./driverPayoutDestinationSSOT.ts";

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: "£",
  USD: "$",
  EUR: "€",
  KES: "KSh",
  NGN: "₦",
  GHS: "GH₵",
  SOS: "Sh",
  ZAR: "R",
};

export async function buildDriverPayoutSettingsPayload(
  supabase: SupabaseClient,
  args: {
    driverId: string;
    serviceAreaId: string | null;
    driver: {
      stripe_account_id?: string | null;
      payouts_enabled?: boolean | null;
      onboarding_complete?: boolean | null;
      charges_enabled?: boolean | null;
      region_id?: string | null;
    };
  },
) {
  const resolvedServiceAreaId = await resolveDriverServiceAreaId(
    supabase,
    args.driverId,
    args.serviceAreaId,
  );

  let regionId: string | null = args.driver.region_id ?? null;
  let currencyCode: string | null = null;
  let currencySymbol: string | null = null;
  let distanceUnit: string | null = null;
  let serviceAreaDriverPayoutGateway: string | null = null;

  if (resolvedServiceAreaId) {
    const { data: area } = await supabase
      .from("service_areas")
      .select(
        "payment_provider, customer_payment_gateway, driver_payout_gateway, region_id, regions!inner(currency_code, distance_unit)",
      )
      .eq("id", resolvedServiceAreaId)
      .maybeSingle();

    serviceAreaDriverPayoutGateway = resolveServiceAreaPaymentProvider(area);
    regionId = (area?.region_id as string | null) ?? regionId;
    const region = area?.regions as { currency_code?: string; distance_unit?: string } | null;
    currencyCode = region?.currency_code ?? null;
    distanceUnit = region?.distance_unit ?? null;
    currencySymbol = currencyCode
      ? (CURRENCY_SYMBOLS[currencyCode.toUpperCase()] ?? currencyCode)
      : null;
  }

  const gatewayCheck = resolvedServiceAreaId
    ? await checkServiceAreaGateway(supabase, resolvedServiceAreaId, "driver")
    : null;

  const driverGatewayStatus = resolvedServiceAreaId
    ? await resolveProviderGatewayStatus(
      supabase,
      serviceAreaDriverPayoutGateway,
      "driver",
    )
    : null;

  const payoutGatewayPayload = driverGatewayStatus
    ? buildDriverPayoutGatewayPayload(driverGatewayStatus, serviceAreaDriverPayoutGateway)
    : {
      provider: null,
      configured: false,
      code: "PAYMENT_GATEWAY_NOT_CONFIGURED",
      message: "Driver payout gateway not selected for this service area",
    };

  const provider = (payoutGatewayPayload.provider as string | null) ?? serviceAreaDriverPayoutGateway;
  const usesStripe = provider === "stripe";

  let providerStatus: string = "not_configured";
  let activeDestination: Record<string, unknown> | null = null;
  let maskedDestination: string | null = null;
  let canChangeDestination = false;
  let reasonIfBlocked: string | null = null;

  async function loadActiveNonStripeDestination(providerId: string) {
    const { data: row } = await supabase
      .from("driver_payout_destinations")
      .select(
        "id, provider, destination_type, destination_label, destination_last4, account_last4, masked_sort_code, masked_account_number, sort_code_last2, account_holder_name, verification_status, provider_link_status, is_active, updated_at",
      )
      .eq("driver_id", args.driverId)
      .eq("provider", providerId)
      .eq("is_active", true)
      .is("archived_at", null)
      .maybeSingle();

    if (!row) return;

    providerStatus = "configured";
    maskedDestination = (row.destination_label as string | null)
      ?? buildMaskedDestinationLabel({
        provider: providerId,
        destinationType: row.destination_type as string,
        destinationLast4:
          (row.destination_last4 as string | null)
          ?? (row.account_last4 as string | null)
          ?? "****",
        accountHolderName: row.account_holder_name as string | null,
      });
    activeDestination = {
      id: row.id,
      provider: row.provider,
      destination_type: row.destination_type,
      destination_last4: row.destination_last4 ?? row.account_last4,
      account_last4: row.account_last4,
      masked_sort_code: row.masked_sort_code,
      masked_account_number: row.masked_account_number,
      sort_code_last2: row.sort_code_last2,
      account_holder_name: row.account_holder_name,
      verification_status: row.verification_status,
      provider_link_status: row.provider_link_status,
      is_active: row.is_active,
      updated_at: row.updated_at,
    };
  }

  if (usesStripe) {
    providerStatus = stripeConnectProviderStatus({
      stripe_account_id: args.driver.stripe_account_id ?? null,
      payouts_enabled: args.driver.payouts_enabled ?? null,
      onboarding_complete: args.driver.onboarding_complete ?? null,
      charges_enabled: args.driver.charges_enabled ?? null,
    });
    canChangeDestination = gatewayCheck?.ok === true;
    reasonIfBlocked = gatewayCheck?.ok === false ? gatewayCheck.reason : null;
  } else if (provider) {
    // Always load the saved destination for Driver UI — even when the booking
    // adapter gate marks Revolut as not ready_for_production. Destination
    // display must not depend on LIVE_PAYMENT_ADAPTERS (Stripe-only).
    await loadActiveNonStripeDestination(provider);
    if (!activeDestination) {
      providerStatus = "destination_required";
    }
    canChangeDestination = gatewayCheck?.ok === true;
    reasonIfBlocked = gatewayCheck?.ok === false
      ? (gatewayCheck.reason ?? "Payout gateway is not configured for this Service Area.")
      : null;
  } else {
    reasonIfBlocked = gatewayCheck?.reason
      ?? "Payout gateway is not configured for this Service Area.";
  }

  return {
    service_area_id: resolvedServiceAreaId,
    region_id: regionId,
    currency_code: currencyCode,
    currency_symbol: currencySymbol,
    distance_unit: distanceUnit,
    payment_provider: provider,
    primary_payment_provider: provider,
    driver_payout_gateway: provider,
    payout_gateway: payoutGatewayPayload,
    provider_status: providerStatus,
    supported_destination_types: provider && !usesStripe
      ? supportedDestinationTypesForProvider(provider)
      : [],
    active_destination: activeDestination,
    masked_destination: maskedDestination,
    can_change_destination: canChangeDestination,
    reason_if_blocked: reasonIfBlocked,
    payout_destination_ui: usesStripe ? "stripe_connect" : provider ? "saved_destination" : "blocked",
  };
}
