import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  handleCORSPreflight,
  successResponse,
  errorResponse,
  validationErrorResponse,
  isValidUUID,
} from "../_shared/security.ts";
import { resolveTripCommunicationConfig } from "../_shared/tripCommunicationMethods.ts";

interface ConfigRequest {
  trip_id?: string;
}

Deno.serve(async (req) => {
  const preflight = handleCORSPreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse("Unauthorized", 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) {
      return errorResponse("Unauthorized", 401);
    }

    const body = (await req.json()) as ConfigRequest;
    const tripId = body.trip_id?.trim();
    if (!tripId || !isValidUUID(tripId)) {
      return validationErrorResponse("Valid trip_id is required");
    }

    const { data: trip, error: tripError } = await userClient
      .from("trips")
      .select("id, status, service_area_id, confirmed_driver_id, passenger_id")
      .eq("id", tripId)
      .maybeSingle();

    if (tripError) {
      console.error("[trip-communication-config] trip lookup failed", tripError);
      return errorResponse("Failed to load trip", 500);
    }
    if (!trip) {
      return errorResponse("Trip not found", 404);
    }

    const { data: driverRow } = await userClient
      .from("drivers")
      .select("id, user_id")
      .eq("user_id", authData.user.id)
      .maybeSingle();

    const isDriver = driverRow?.id && trip.confirmed_driver_id === driverRow.id;
    const isPassenger = trip.passenger_id === authData.user.id;
    if (!isDriver && !isPassenger) {
      return errorResponse("Forbidden", 403);
    }

    let settings = null;
    if (trip.service_area_id) {
      const { data, error } = await userClient
        .from("service_area_communication_settings")
        .select(
          "is_enabled, voip_enabled, call_masking_enabled, default_method, maximum_call_duration_seconds",
        )
        .eq("service_area_id", trip.service_area_id)
        .maybeSingle();

      if (error) {
        console.error("[trip-communication-config] settings lookup failed", error);
        return errorResponse("Failed to load communication settings", 500);
      }
      settings = data;
    }

    const config = resolveTripCommunicationConfig(trip.status, settings);
    return successResponse(config);
  } catch (error) {
    console.error("[trip-communication-config] unexpected error", error);
    return errorResponse("Internal server error", 500);
  }
});
