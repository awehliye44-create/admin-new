import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface SidebarCounts {
  activeTrips: number;
  scheduledRides: number;
  pendingFeedback: number;
  pendingDocuments: number;
  activePromoCodes: number;
  pendingAccountRequests: number;
}

const CACHE_KEY = 'sidebar-counts-cache';
const CACHE_TTL_MS = 30000; // 30 seconds

interface CachedCounts {
  data: SidebarCounts;
  timestamp: number;
}

const defaultCounts: SidebarCounts = {
  activeTrips: 0,
  scheduledRides: 0,
  pendingFeedback: 0,
  pendingDocuments: 0,
  activePromoCodes: 0,
  pendingAccountRequests: 0,
};

export function useSidebarCounts() {
  const [counts, setCounts] = useState<SidebarCounts>(defaultCounts);
  const [isLoading, setIsLoading] = useState(true);

  const fetchCounts = useCallback(async (skipCache = false) => {
    // Check cache first
    if (!skipCache) {
      try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
          const parsed: CachedCounts = JSON.parse(cached);
          if (Date.now() - parsed.timestamp < CACHE_TTL_MS) {
            setCounts(parsed.data);
            setIsLoading(false);
            return;
          }
        }
      } catch (e) {
        // Ignore cache errors
      }
    }

    try {
      // Fetch all counts in parallel
      const [
        activeTripsResult,
        scheduledRidesResult,
        pendingFeedbackResult,
        pendingDocumentsResult,
        activePromoCodesResult,
      ] = await Promise.all([
        // Active trips (status is pending, accepted, arrived, in_progress)
        supabase
          .from('trips')
          .select('id', { count: 'exact', head: true })
          .in('status', ['pending', 'accepted', 'arrived', 'in_progress', 'driver_assigned']),
        
        // Scheduled rides (is_scheduled = true and scheduled_at in future)
        supabase
          .from('trips')
          .select('id', { count: 'exact', head: true })
          .eq('is_scheduled', true)
          .in('scheduled_status', ['pending', 'confirmed']),
        
        // Pending feedback (status = pending or new)
        supabase
          .from('rider_feedback')
          .select('id', { count: 'exact', head: true })
          .in('status', ['pending', 'new']),
        
        // Pending documents (status = pending)
        supabase
          .from('documents')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),
        
        // Active promo codes
        supabase
          .from('promo_codes')
          .select('id', { count: 'exact', head: true })
          .eq('is_active', true),
      ]);

      const newCounts: SidebarCounts = {
        activeTrips: activeTripsResult.count || 0,
        scheduledRides: scheduledRidesResult.count || 0,
        pendingFeedback: pendingFeedbackResult.count || 0,
        pendingDocuments: pendingDocumentsResult.count || 0,
        activePromoCodes: activePromoCodesResult.count || 0,
        pendingAccountRequests: 0, // No table yet
      };

      setCounts(newCounts);
      
      // Cache the results
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        data: newCounts,
        timestamp: Date.now(),
      }));
    } catch (error) {
      console.error('Error fetching sidebar counts:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchCounts();
  }, [fetchCounts]);

  // Refresh on window focus
  useEffect(() => {
    const handleFocus = () => {
      fetchCounts(true); // Skip cache on focus
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [fetchCounts]);

  // Set up real-time subscriptions for key tables
  useEffect(() => {
    const channel = supabase
      .channel('sidebar-counts')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trips' },
        () => fetchCounts(true)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rider_feedback' },
        () => fetchCounts(true)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'documents' },
        () => fetchCounts(true)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchCounts]);

  return { counts, isLoading, refresh: () => fetchCounts(true) };
}
