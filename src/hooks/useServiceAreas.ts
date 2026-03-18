import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface ServiceArea {
  id: string;
  name: string;
  code: string | null;
  country: string | null;
  timezone: string;
  /**
   * @deprecated Currency is owned by Region. Use useRegions() to resolve currency.
   * This field exists in the DB but must NOT be used as a source of truth.
   */
  currency_code: string;
  /**
   * @deprecated Distance unit is owned by Region. Use useRegions() to resolve distance_unit.
   * This field exists in the DB but must NOT be used as a source of truth.
   */
  distance_unit: string;
  region_id: string;
  is_active: boolean;
  geo_boundary: any;
  center_lat: number | null;
  center_lng: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Shared hook for service areas reference data.
 * Cached globally — every page that needs service areas shares this single query.
 * staleTime = 5 min (service areas rarely change).
 */
export function useServiceAreas(options?: { activeOnly?: boolean }) {
  const activeOnly = options?.activeOnly ?? false;

  return useQuery({
    queryKey: ["service-areas", { activeOnly }],
    queryFn: async () => {
      let query = supabase
        .from("service_areas")
        .select("*")
        .order("name", { ascending: true });

      if (activeOnly) {
        query = query.eq("is_active", true);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as ServiceArea[];
    },
    staleTime: 5 * 60 * 1000,
  });
}

/** Convenience: service areas as a lookup map keyed by id */
export function useServiceAreasMap(options?: { activeOnly?: boolean }) {
  const query = useServiceAreas(options);
  const map = new Map<string, ServiceArea>();
  query.data?.forEach((sa) => map.set(sa.id, sa));
  return { ...query, map };
}
