import { supabase } from "@/integrations/supabase/client";
import {
  LOCATION_SEARCH_EDGE_FN,
  LOCATION_SEARCH_MIN_QUERY_LENGTH,
  parseOnecabLocationResults,
  shouldCallExternalLocationSearch,
} from "../../shared/onecabLocationSearchSSOT";

export async function isAdminLocationSearchSsotEnabled(serviceAreaId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_location_search_ssot_enabled", {
    p_service_area_id: serviceAreaId,
  });
  if (error) return false;
  return data === true;
}

export async function searchOnecabLocationsForAdmin(args: {
  query: string;
  service_area_id: string;
  session_token?: string;
  user_latitude?: number | null;
  user_longitude?: number | null;
}) {
  if (!shouldCallExternalLocationSearch(args.query, LOCATION_SEARCH_MIN_QUERY_LENGTH)) {
    return [];
  }
  const { data, error } = await supabase.functions.invoke(LOCATION_SEARCH_EDGE_FN, {
    body: {
      action: "search",
      query: args.query,
      service_area_id: args.service_area_id,
      booking_context: "ADMIN_BOOKING",
      session_token: args.session_token ?? null,
      user_latitude: args.user_latitude ?? null,
      user_longitude: args.user_longitude ?? null,
      language: "en",
      limit: 8,
    },
  });
  if (error || !data?.success) return [];
  return parseOnecabLocationResults(data.results);
}
