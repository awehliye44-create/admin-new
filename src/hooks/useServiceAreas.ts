import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface ServiceArea {
  id: string;
  name: string;
  code: string | null;
  country: string | null;
  timezone: string;
  /**
   * @deprecated Currency is owned by Region. Use region.currency_code instead.
   */
  currency_code: string;
  /**
   * @deprecated Distance unit is owned by Region. Use region.distance_unit instead.
   */
  distance_unit: string;
  region_id: string;
  is_active: boolean;
  geo_boundary: any;
  center_lat: number | null;
  center_lng: number | null;
  created_at: string;
  updated_at: string;
  /** Joined from regions table — Region is the single source of truth */
  region?: {
    currency_code: string;
    distance_unit: string;
    name?: string;
  } | null;
  financial_model?: string | null;
  commission_wallet_enabled?: boolean | null;
  commission_wallet_currency?: string | null;
  welcome_credit_enabled?: boolean | null;
  welcome_credit_amount_minor?: number | null;
  welcome_credit_max_drivers?: number | null;
}

/**
 * Shared hook for service areas reference data.
 * Cached globally — every page that needs service areas shares this single query.
 * Joins regions table so currency/units come from Region (single source of truth).
 * staleTime = 5 min (service areas rarely change).
 */
export function useServiceAreas(options?: { activeOnly?: boolean }) {
  const activeOnly = options?.activeOnly ?? false;

  return useQuery({
    queryKey: ["service-areas", { activeOnly }],
    queryFn: async () => {
      let query = supabase
        .from("service_areas")
        .select(
          "*, financial_model, commission_wallet_enabled, commission_wallet_currency, welcome_credit_enabled, welcome_credit_amount_minor, welcome_credit_max_drivers, region:regions(currency_code, distance_unit, name)",
        )
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
