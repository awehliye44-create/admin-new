import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface VehicleType {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  capacity: number;
  icon: string | null;
  features: string[] | null;
  display_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Shared hook for vehicle types reference data.
 * Cached globally — every page that needs vehicle types shares this single query.
 * staleTime = 5 min (vehicle types rarely change).
 */
export function useVehicleTypes(options?: { activeOnly?: boolean }) {
  const activeOnly = options?.activeOnly ?? true;

  return useQuery({
    queryKey: ["vehicle-types", { activeOnly }],
    queryFn: async () => {
      let query = supabase
        .from("vehicle_types")
        .select("*")
        .order("display_order", { ascending: true });

      if (activeOnly) {
        query = query.eq("is_active", true);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as VehicleType[];
    },
    staleTime: 5 * 60 * 1000,
  });
}
