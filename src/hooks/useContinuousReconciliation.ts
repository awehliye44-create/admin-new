import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export function useContinuousReconciliation(regionId?: string | null) {
  return useQuery({
    queryKey: ['continuous-reconciliation', regionId ?? 'all'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('admin-continuous-reconciliation', {
        body: regionId ? { region_id: regionId } : {},
      });
      if (error) throw error;
      return data as {
        success: boolean;
        summary: Record<string, number>;
        rows: Array<{
          driver_id: string;
          driver_code: string | null;
          classification: string;
          reasons: string[];
        }>;
      };
    },
    staleTime: 120_000,
  });
}
