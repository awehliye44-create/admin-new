import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface Region {
  id: string;
  name: string;
  status: string;
  distance_unit: string;
  currency_code: string;
  timezone: string;
  geo_boundary: any;
  created_at: string;
  updated_at: string;
}

/**
 * Shared hook for regions reference data.
 * Cached globally — every page that needs regions shares this single query.
 * staleTime = 5 min (regions rarely change).
 */
export function useRegions() {
  return useQuery({
    queryKey: ["regions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("regions")
        .select("*")
        .order("name", { ascending: true });

      if (error) throw error;
      return (data ?? []) as Region[];
    },
    staleTime: 5 * 60 * 1000,
  });
}

/** Convenience: regions as a lookup map keyed by id */
export function useRegionsMap() {
  const query = useRegions();
  const map = new Map<string, Region>();
  query.data?.forEach((r) => map.set(r.id, r));
  return { ...query, map };
}

/**
 * Resolve Region settings (currency_code, distance_unit) for a given region_id.
 * Region is the SINGLE SOURCE OF TRUTH for currency and units.
 * Service Areas inherit these values from their parent Region and must not override them.
 */
export function useRegionSettings(regionId: string | undefined) {
  const { map, isLoading, error } = useRegionsMap();
  const region = regionId ? map.get(regionId) : undefined;
  return {
    region,
    currencyCode: region?.currency_code,
    distanceUnit: region?.distance_unit,
    isLoading,
    error,
    /** True if regionId was provided but region was not found (after loading) */
    isMissing: !isLoading && !!regionId && !region,
  };
}
