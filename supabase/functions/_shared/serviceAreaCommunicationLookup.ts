import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
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
};

export async function loadTripCommunicationRuntimeContext(
  client: SupabaseClient,
  trip: { status: string; service_area_id: string | null },
  envMaskingCallerId: string,
): Promise<TripCommunicationRuntimeContext> {
  let settings: ServiceAreaCommunicationRow | null = null;
  let maskingConfig: ServiceAreaMaskingConfigRow | null = null;

  if (trip.service_area_id) {
    const { data: settingsRow } = await client
      .from("service_area_communication_settings")
      .select(
        "is_enabled, voip_enabled, call_masking_enabled, default_method, maximum_call_duration_seconds",
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
  }

  const maxCallDurationSeconds = Math.max(
    60,
    settings?.maximum_call_duration_seconds ?? DEFAULT_MAX_CALL_DURATION_SECONDS,
  );

  const resolved = resolveTripCommunicationConfig(trip.status, settings);
  const callMaskingEnabled = resolved.methods.some((method) => method.method === "call_masking");
  const voipEnabled = resolved.methods.some((method) => method.method === "voip");

  const maskingCallerId = callMaskingEnabled
    ? (maskingConfig?.is_active && maskingConfig.outbound_caller_id
      ? maskingConfig.outbound_caller_id
      : envMaskingCallerId)
    : null;

  return {
    settings,
    maskingConfig,
    maxCallDurationSeconds,
    maskingCallerId,
    callMaskingEnabled,
    voipEnabled,
  };
}

export function assertCallMaskingAllowed(context: TripCommunicationRuntimeContext): string | null {
  if (!context.callMaskingEnabled) {
    return "Call masking is not enabled for this service area.";
  }
  if (!context.maskingCallerId?.trim()) {
    return "Call masking is not configured for this service area.";
  }
  return null;
}
