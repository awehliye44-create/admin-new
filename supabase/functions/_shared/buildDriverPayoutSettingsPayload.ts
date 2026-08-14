/**
 * Build driver payout settings payload — backend SSOT for driver wallet payout UI.
 *
 * Stripe Connect UI/runtime branch removed (Stripe retirement Batch 4).
 * UK-bank / Revolut / manual-bank destinations via driver_payout_destinations preserved.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  buildDriverPayoutGatewayPayload,
  checkServiceAreaGateway,
  resolveServiceAreaPaymentProvider,
} from "./paymentGatewayGuard.ts";
import { resolveProviderGatewayStatus } from "./paymentGatewayStatus.ts";
import { resolveDriverServiceAreaId } from "./resolveDriverServiceAreaId.ts";
import {
  buildMaskedDestinationLabel,
  supportedDestinationTypesForProvider,
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

  // Stripe Connect payout UI retired — never expose Connect onboarding path.
  if (provider === "stripe") {
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
      provider_status: "not_configured",
      supported_destination_types: [],
      active_destination: null,
      masked_destination: null,
      can_change_destination: false,
      reason_if_blocked:
        "Stripe Connect payouts are retired. Ask admin to set a Revolut or bank payout gateway for this service area.",
      payout_destination_ui: "blocked",
    };
  }

  let providerStatus: string = "not_configured";
  let activeDestination: Record<string, unknown> | null = null;
  let maskedDestination: string | null = null;
  let canChangeDestination = false;
  let reasonIfBlocked: string | null = null;

  if (provider && gatewayCheck?.ok) {
    canChangeDestination = true;
    providerStatus = "destination_required";
    const { data: row } = await supabase
      .from("driver_payout_destinations")
      .select(
        "id, destination_type, destination_label, destination_last4, account_holder_name, is_active, updated_at",
      )
      .eq("driver_id", args.driverId)
      .eq("provider", provider)
      .eq("is_active", true)
      .is("archived_at", null)
      .maybeSingle();

    if (row) {
      providerStatus = "configured";
      maskedDestination = (row.destination_label as string | null)
        ?? buildMaskedDestinationLabel({
          provider,
          destinationType: row.destination_type as string,
          destinationLast4: (row.destination_last4 as string | null) ?? "****",
          accountHolderName: row.account_holder_name as string | null,
        });
      activeDestination = {
        id: row.id,
        destination_type: row.destination_type,
        destination_last4: row.destination_last4,
        account_holder_name: row.account_holder_name,
        is_active: row.is_active,
        updated_at: row.updated_at,
      };
    }
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
    supported_destination_types: provider
      ? supportedDestinationTypesForProvider(provider)
      : [],
    active_destination: activeDestination,
    masked_destination: maskedDestination,
    can_change_destination: canChangeDestination,
    reason_if_blocked: reasonIfBlocked,
    payout_destination_ui: provider ? "saved_destination" : "blocked",
  };
}
