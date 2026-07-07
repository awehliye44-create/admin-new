/**
 * Service Area + Region config SSOT payload builder for edge functions.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { getCurrencySymbol } from "../../../shared/currency.ts";
import {
  checkServiceAreaGateway,
  resolveServiceAreaPaymentProvider,
} from "./paymentGatewayGuard.ts";
import {
  buildServiceAreaPaymentMethodFlags,
  enrichCustomerGatewayPayloadForBooking,
} from "./customerPaymentWorkflow.ts";
import {
  gatewayStatusToPaymentGatewayPayload,
  resolveProviderGatewayStatus,
} from "./paymentGatewayStatus.ts";
import {
  buildDigitalPaymentMethodsPayload,
  parseServiceAreaPaymentMethodFlags,
} from "./paymentMethodSSOT.ts";
import { getProviderSecrets } from "./paymentProviders/secretManager.ts";

export const CONFIG_ERROR_CURRENCY_MISSING = "CONFIG_ERROR_CURRENCY_MISSING";
export const CONFIG_ERROR_REGION_UNIT_MISSING = "CONFIG_ERROR_REGION_UNIT_MISSING";

export type EnabledPaymentMethods = {
  card: boolean;
  saved_card: boolean;
  apple_pay: boolean;
  google_pay: boolean;
  cash: boolean;
  wallet: boolean;
  mobile_wallet: boolean;
  pay_by_bank: boolean;
};

export type GatewayStatusSummary = {
  provider: string | null;
  status: string | null;
  ready_for_production: boolean;
  configured: boolean;
};

export type ServiceAreaConfigPayload = {
  region_id: string;
  service_area_id: string;
  currency_code: string;
  currency_symbol: string;
  distance_unit: string;
  /** Admin-selected primary provider — sole SSOT for collection + payout. */
  payment_provider: string | null;
  /** Alias for payment_provider (customer + driver apps). */
  primary_payment_provider: string | null;
  /** Mirror of payment_provider (compat). */
  customer_payment_gateway: string | null;
  /** Mirror of payment_provider (compat). */
  driver_payout_gateway: string | null;
  enabled_payment_methods: EnabledPaymentMethods | null;
  enabled_mobile_wallet_methods: string[] | null;
  booking_workflow: "stripe_preauth" | "revolut_preauth" | "mobile_wallet_collect" | "blocked";
  gateway_status: {
    customer: GatewayStatusSummary;
    driver: GatewayStatusSummary;
  };
  digital_payment_methods: ReturnType<typeof buildDigitalPaymentMethodsPayload>;
  paymentGateways: {
    customer: Record<string, unknown>;
    driver: Record<string, unknown>;
  };
};

function deriveCurrencySymbol(currencyCode: string): string {
  const sym = getCurrencySymbol(currencyCode);
  return sym === "—" ? `${currencyCode} ` : sym;
}

export async function buildServiceAreaConfigPayload(
  supabase: SupabaseClient,
  serviceAreaId: string,
): Promise<ServiceAreaConfigPayload | { error: string; code: string }> {
  const { data: serviceAreaRow, error: saErr } = await supabase
    .from("service_areas")
    .select(
      "id, name, tips_enabled, payment_provider, customer_payment_gateway, driver_payout_gateway, regions!inner(id, name, currency_code, distance_unit)",
    )
    .eq("id", serviceAreaId)
    .eq("is_active", true)
    .maybeSingle();

  if (saErr || !serviceAreaRow) {
    return { error: "Service area not found", code: CONFIG_ERROR_REGION_UNIT_MISSING };
  }

  const joinedRegion = serviceAreaRow.regions as unknown;
  const region = (Array.isArray(joinedRegion) ? joinedRegion[0] : joinedRegion) as Record<
    string,
    unknown
  > | null;
  const regionId = region?.id as string | undefined;
  const currencyCode = region?.currency_code as string | null;
  const distanceUnit = region?.distance_unit as string | null;

  if (!regionId || !currencyCode || !distanceUnit) {
    return { error: "Region configuration incomplete", code: CONFIG_ERROR_REGION_UNIT_MISSING };
  }

  const currencySymbol = deriveCurrencySymbol(String(currencyCode).toUpperCase());
  const paymentProvider = resolveServiceAreaPaymentProvider(serviceAreaRow);

  const [customerGatewayStatus, driverGatewayStatus, paymentRes, customerGatewayCheck] =
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

  const pm = paymentRes.data;
  const methodFlags = buildServiceAreaPaymentMethodFlags(
    pm as Record<string, unknown> | null,
    customerGatewayCheck,
  );

  const customerPayload = enrichCustomerGatewayPayloadForBooking(
    gatewayStatusToPaymentGatewayPayload(customerGatewayStatus, paymentProvider),
  );
  const driverPayload = gatewayStatusToPaymentGatewayPayload(
    driverGatewayStatus,
    paymentProvider,
  );

  const methodFlagsParsed = parseServiceAreaPaymentMethodFlags(
    pm as Record<string, unknown> | null,
  );
  let hasRevolutBusinessAccountId = false;
  if (paymentProvider === "revolut" && customerGatewayStatus.environment) {
    const revolutSecrets = await getProviderSecrets(
      supabase,
      "revolut",
      customerGatewayStatus.environment,
    );
    hasRevolutBusinessAccountId = Boolean(revolutSecrets.merchant_id?.trim());
  }
  const digital_payment_methods = buildDigitalPaymentMethodsPayload({
    flags: methodFlagsParsed,
    customerGateway: customerGatewayStatus,
    driverGateway: driverGatewayStatus,
    mobileWalletMethods: methodFlags.enabled_mobile_wallet_methods,
    hasRevolutBusinessAccountId,
  });

  return {
    region_id: regionId,
    service_area_id: serviceAreaId,
    currency_code: String(currencyCode).toUpperCase(),
    currency_symbol: currencySymbol,
    distance_unit: distanceUnit,
    payment_provider: paymentProvider,
    primary_payment_provider: paymentProvider,
    customer_payment_gateway: paymentProvider,
    driver_payout_gateway: paymentProvider,
    enabled_payment_methods: methodFlags.enabled_payment_methods,
    enabled_mobile_wallet_methods: methodFlags.enabled_mobile_wallet_methods,
    booking_workflow: methodFlags.booking_workflow,
    gateway_status: {
      customer: {
        provider: customerGatewayStatus.provider,
        status: customerGatewayStatus.status,
        ready_for_production: customerGatewayStatus.ready_for_production,
        configured: customerGatewayStatus.configured,
      },
      driver: {
        provider: driverGatewayStatus.provider,
        status: driverGatewayStatus.status,
        ready_for_production: driverGatewayStatus.ready_for_production,
        configured: driverGatewayStatus.configured,
      },
    },
    digital_payment_methods,
    paymentGateways: {
      customer: customerPayload,
      driver: driverPayload,
    },
  };
}
