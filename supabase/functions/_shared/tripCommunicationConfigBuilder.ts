import type { TripCommunicationConfigResponse } from "../../../shared/tripCommunicationSsot.ts";
import type { ServiceAreaCommunicationRow } from "./tripCommunicationMethods.ts";
import { loadTripCommunicationRuntimeContext } from "./serviceAreaCommunicationLookup.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { resolveTripCommunicationConfig } from "./tripCommunicationMethods.ts";

export async function buildTripCommunicationConfigForTrip(
  client: SupabaseClient,
  trip: {
    id: string;
    status: string;
    service_area_id: string | null;
    driver_id?: string | null;
    confirmed_driver_id?: string | null;
    passenger_id?: string | null;
  },
): Promise<TripCommunicationConfigResponse & { config_version: number; service_area_id: string | null }> {
  const runtime = await loadTripCommunicationRuntimeContext(client, trip);
  const config = resolveTripCommunicationConfig(trip.status, runtime.settings);

  if (!trip.service_area_id || !runtime.settings) {
    console.log("COMMUNICATION_CONFIG_MISSING", JSON.stringify({
      event: "COMMUNICATION_CONFIG_MISSING",
      trip_id: trip.id,
      service_area_id: trip.service_area_id,
      trip_status: trip.status,
    }));
  } else {
    console.log("COMMUNICATION_CONFIG_LOADED", JSON.stringify({
      event: "COMMUNICATION_CONFIG_LOADED",
      trip_id: trip.id,
      service_area_id: trip.service_area_id,
      config_version: runtime.configVersion,
      methods: config.methods.map((m) => m.method),
      calling_available: config.calling_available,
    }));
  }

  return {
    ...config,
    trip_id: trip.id,
    config_version: runtime.configVersion,
    service_area_id: trip.service_area_id,
  };
}

export type { ServiceAreaCommunicationRow };
