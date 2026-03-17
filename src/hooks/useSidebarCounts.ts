import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface SidebarCounts {
  activeTrips: number;
  scheduledRides: number;
  pendingFeedback: number;
  pendingDocuments: number;
  activePromoCodes: number;
  pendingAccountRequests: number;
  pendingDrivers: number;
  pendingVehicleChanges: number;
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
  pendingDrivers: 0,
  pendingVehicleChanges: 0,
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
        accountRequestsResult,
        pendingDriversResult,
        pendingVehicleChangesResult,
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
        
        // Pending account requests from admin_settings JSON
        supabase
          .from('admin_settings')
          .select('setting_value')
          .eq('setting_key', 'account_requests')
          .maybeSingle(),
        
        // Pending drivers (approval_status = pending)
        supabase
          .from('drivers')
          .select('id', { count: 'exact', head: true })
          .eq('approval_status', 'pending'),
        
        // Pending vehicle change requests
        supabase
          .from('vehicle_change_requests')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),
      ]);

      // Parse account requests from JSON
      let pendingAccountRequests = 0;
      if (accountRequestsResult.data?.setting_value) {
        const requests = accountRequestsResult.data.setting_value as any[];
        pendingAccountRequests = Array.isArray(requests) 
          ? requests.filter((r: any) => r.status === 'pending').length 
          : 0;
      }

      const newCounts: SidebarCounts = {
        activeTrips: activeTripsResult.count || 0,
        scheduledRides: scheduledRidesResult.count || 0,
        pendingFeedback: pendingFeedbackResult.count || 0,
        pendingDocuments: pendingDocumentsResult.count || 0,
        activePromoCodes: activePromoCodesResult.count || 0,
        pendingAccountRequests,
        pendingDrivers: pendingDriversResult.count || 0,
        pendingVehicleChanges: pendingVehicleChangesResult.count || 0,
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
      fetchCounts(true);
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [fetchCounts]);

  // Realtime subscriptions handle freshness — no polling needed

  // Set up real-time subscriptions for all badge-relevant tables
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
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'drivers' },
        () => fetchCounts(true)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'promo_codes' },
        () => fetchCounts(true)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'admin_settings' },
        () => fetchCounts(true)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'vehicle_change_requests' },
        () => fetchCounts(true)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchCounts]);

  return { counts, isLoading, refresh: () => fetchCounts(true) };
}
