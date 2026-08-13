import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  isPlaceholderOutboundCallerId,
  normalizeOutboundCallerIdE164,
  resolveOutboundCallerIdPriority,
} from "../../../shared/communicationSsot.ts";
import {
  resolveTripCommunicationConfig,
  type ServiceAreaCommunicationRow,
} from "./tripCommunicationMethods.ts";

export const DEFAULT_MAX_CALL_DURATION_SECONDS = 600;

export type ServiceAreaMaskingConfigRow = {
  outbound_caller_id: string;
  is_active: boolean;
  provider_config_id: string | null;
};

export type TripCommunicationRuntimeContext = {
  settings: ServiceAreaCommunicationRow | null;
  maskingConfig: ServiceAreaMaskingConfigRow | null;
  maxCallDurationSeconds: number;
  maskingCallerId: string | null;
  callMaskingEnabled: boolean;
  voipEnabled: boolean;
  configVersion: number;
};

export function isTripDriverParticipant(
  trip: { driver_id?: string | null; confirmed_driver_id?: string | null },
  driverId: string,
): boolean {
  return trip.confirmed_driver_id === driverId || trip.driver_id === driverId;
}

export async function loadTripCommunicationRuntimeContext(
  client: SupabaseClient,
  trip: { status: string; service_area_id: string | null },
): Promise<TripCommunicationRuntimeContext> {
  let settings: (ServiceAreaCommunicationRow & {
    config_version?: number;
    outbound_caller_id?: string | null;
    voip_provider?: string;
    voip_rate_per_minute_minor?: number;
    masked_call_rate_per_minute_minor?: number;
  }) | null = null;
  let maskingConfig: ServiceAreaMaskingConfigRow | null = null;
  let catalogCallerId: string | null = null;

  if (trip.service_area_id) {
    const { data: settingsRow } = await client
      .from("service_area_communication_settings")
      .select(
        "is_enabled, voip_enabled, call_masking_enabled, default_method, maximum_call_duration_seconds, config_version, outbound_caller_id, voip_provider, voip_rate_per_minute_minor, masked_call_rate_per_minute_minor",
      )
      .eq("service_area_id", trip.service_area_id)
      .maybeSingle();
    settings = settingsRow;

    const { data: maskingRow } = await client
      .from("service_area_call_masking_config")
      .select("outbound_caller_id, is_active, provider_config_id")
      .eq("service_area_id", trip.service_area_id)
      .maybeSingle();
    maskingConfig = maskingRow;

    if (maskingConfig?.provider_config_id) {
      const { data: catalogRow } = await client
        .from("call_masking_provider_configs")
        .select("outbound_caller_id")
        .eq("id", maskingConfig.provider_config_id)
        .maybeSingle();
      catalogCallerId = catalogRow?.outbound_caller_id ?? null;
    }
  }

  const maxCallDurationSeconds = Math.max(
    60,
    settings?.maximum_call_duration_seconds ?? DEFAULT_MAX_CALL_DURATION_SECONDS,
  );

  const resolved = resolveTripCommunicationConfig(trip.status, settings);
  const callMaskingEnabled = resolved.methods.some((method) => method.method === "call_masking");
  const voipEnabled = resolved.methods.some((method) => method.method === "voip");

  const maskingCallerId = callMaskingEnabled
    ? resolveOutboundCallerIdPriority({
      serviceAreaOutboundCallerId: settings?.outbound_caller_id,
      maskingConfigOutboundCallerId: maskingConfig?.is_active
        ? maskingConfig.outbound_caller_id
        : null,
      providerCatalogOutboundCallerId: catalogCallerId,
    })
    : null;

  return {
    settings,
    maskingConfig,
    maxCallDurationSeconds,
    maskingCallerId,
    callMaskingEnabled,
    voipEnabled,
    configVersion: settings?.config_version ?? 1,
  };
}

export function assertCallMaskingAllowed(context: TripCommunicationRuntimeContext): string | null {
  if (!context.callMaskingEnabled) {
    return "Call masking is not enabled for this service area.";
  }
  const callerId = normalizeOutboundCallerIdE164(context.maskingCallerId);
  if (!callerId || isPlaceholderOutboundCallerId(callerId)) {
    return "Outbound caller ID is not configured for this service area.";
  }
  return null;
}
