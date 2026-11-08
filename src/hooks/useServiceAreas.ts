import { useQuery } from "@tanstack/react-query";
import { adminServiceAreasLookup } from "@/lib/adminPageGatedData";

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
  archived_at?: string | null;
  geo_boundary?: any;
  center_lat: number | null;
  center_lng: number | null;
  created_at: string;
  updated_at: string;
  /** Joined from regions table — Region is the single source of truth */
  region?: {
    currency_code: string;
    distance_unit: string;
    name?: string;
    country_code?: string | null;
  } | null;
  financial_model?: string | null;
  commission_wallet_enabled?: boolean | null;
  commission_wallet_currency?: string | null;
  welcome_credit_enabled?: boolean | null;
  welcome_credit_amount_minor?: number | null;
  welcome_credit_max_drivers?: number | null;
}

export type UseServiceAreasOptions = {
  /** Exact page grant asserted by admin_service_areas_lookup. */
  pageSlug: string;
  activeOnly?: boolean;
  /** Services management may need archived rows; label consumers must not. */
  includeArchived?: boolean;
};

/**
 * Shared hook for service areas reference data via page-gated RPC.
 * staleTime = 5 min (service areas rarely change).
 */
export function useServiceAreas(options: UseServiceAreasOptions) {
  const activeOnly = options.activeOnly ?? false;
  const includeArchived = options.includeArchived ?? false;
  const pageSlug = options.pageSlug;

  return useQuery({
    queryKey: ["service-areas", pageSlug, { activeOnly, includeArchived }],
    queryFn: async () => {
      const { rows } = await adminServiceAreasLookup<ServiceArea>(pageSlug, {
        active_only: activeOnly,
        include_archived: includeArchived,
      });
      return rows;
    },
    staleTime: 5 * 60 * 1000,
    enabled: Boolean(pageSlug),
  });
}

/** Convenience: service areas as a lookup map keyed by id */
export function useServiceAreasMap(options: UseServiceAreasOptions) {
  const query = useServiceAreas(options);
  const map = new Map<string, ServiceArea>();
  query.data?.forEach((sa) => map.set(sa.id, sa));
  return { ...query, map };
}
