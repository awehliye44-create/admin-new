import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { sortEvidence, type TripLocationEvidence } from '@/lib/tripLocationEvidence';

export function useTripLocationEvidence(tripId: string | null | undefined) {
  return useQuery({
    queryKey: ['trip-location-evidence', tripId],
    enabled: Boolean(tripId),
    staleTime: 60_000,
    queryFn: async (): Promise<TripLocationEvidence[]> => {
      const { data, error } = await supabase
        .from('trip_action_location_evidence')
        .select('*')
        .eq('trip_id', tripId as string);
      if (error) throw new Error(`Could not load location proof: ${error.message}`);
      return sortEvidence((data ?? []) as TripLocationEvidence[]);
    },
  });
}
