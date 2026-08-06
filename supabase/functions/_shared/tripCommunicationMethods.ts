import {
  buildCommunicationMethods,
  TRIP_COMMUNICATION_SSOT,
  type TripCommunicationConfigResponse,
} from "../../../shared/tripCommunicationSsot.ts";
import { isCallableTripStatus } from "./callMaskingConfig.ts";

export type ServiceAreaCommunicationRow = {
  is_enabled: boolean;
  voip_enabled: boolean;
  call_masking_enabled: boolean;
  default_method: "voip" | "call_masking";
  maximum_call_duration_seconds: number;
};

export function resolveTripCommunicationConfig(
  tripStatus: string,
  settings: ServiceAreaCommunicationRow | null,
): TripCommunicationConfigResponse {
  if (!isCallableTripStatus(tripStatus)) {
    return {
      methods: [],
      maximum_call_duration_seconds: settings?.maximum_call_duration_seconds ?? 600,
      calling_available: false,
      disabled_message: TRIP_COMMUNICATION_SSOT.disabledMessage,
    };
  }

  if (!settings) {
    return {
      methods: [],
      maximum_call_duration_seconds: 600,
      calling_available: false,
      disabled_message: TRIP_COMMUNICATION_SSOT.disabledMessage,
    };
  }

  const methods = buildCommunicationMethods({
    is_enabled: settings.is_enabled,
    voip_enabled: settings.voip_enabled,
    call_masking_enabled: settings.call_masking_enabled,
    default_method: settings.default_method,
  });

  return {
    methods,
    maximum_call_duration_seconds: settings.maximum_call_duration_seconds,
    calling_available: methods.length > 0,
    disabled_message: methods.length > 0 ? null : TRIP_COMMUNICATION_SSOT.disabledMessage,
  };
}
