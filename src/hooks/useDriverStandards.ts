import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { parseDriverStandards, type DriverStandardsData } from "@/lib/driverStandardsTypes";

export function useDriverStandards(
  driverId: string | undefined,
  periodDays = 30,
) {
  return useQuery({
    queryKey: ["driver-standards", driverId, periodDays],
    enabled: Boolean(driverId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<DriverStandardsData | null> => {
      if (!driverId) return null;

      const { data, error } = await supabase.rpc("get_driver_standards", {
        p_driver_id: driverId,
        p_period_days: periodDays,
      });

      if (error) {
        console.error("[useDriverStandards]", error.message);
        throw error;
      }

      return parseDriverStandards(data);
    },
  });
}
