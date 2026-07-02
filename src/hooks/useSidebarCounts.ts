import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { ACTIVE_TRIP_DB_STATUSES } from '@/lib/activeTripStatuses';
import { countAdminActiveTrips } from '@/lib/adminActiveTripFilter';

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

/** One realtime channel shared by AdminSidebar + Dashboard QuickActions (same channel name cannot subscribe twice). */
let sidebarCountsChannel: RealtimeChannel | null = null;
const sidebarCountsRefetchers = new Set<() => void>();

function refetchAllSidebarCounts() {
  sidebarCountsRefetchers.forEach((refetch) => refetch());
}

function registerSidebarCountsRealtime(refetch: () => void): () => void {
  sidebarCountsRefetchers.add(refetch);
  if (!sidebarCountsChannel) {
    sidebarCountsChannel = supabase
      .channel('sidebar-counts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trips' }, refetchAllSidebarCounts)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rider_feedback' }, refetchAllSidebarCounts)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'documents' }, refetchAllSidebarCounts)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'drivers' }, refetchAllSidebarCounts)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'promo_codes' }, refetchAllSidebarCounts)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'admin_settings' }, refetchAllSidebarCounts)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vehicle_change_requests' }, refetchAllSidebarCounts)
      .subscribe();
  }
  return () => {
    sidebarCountsRefetchers.delete(refetch);
    if (sidebarCountsRefetchers.size === 0 && sidebarCountsChannel) {
      supabase.removeChannel(sidebarCountsChannel);
      sidebarCountsChannel = null;
    }
  };
}

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
        // Active trips — SSOT status list + exclude stale unassigned searching
        supabase
          .from('trips')
          .select('id, status, searching_expires_at, driver_id, created_at, trip_code')
          .in('status', [...ACTIVE_TRIP_DB_STATUSES]),
        
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
        activeTrips: countAdminActiveTrips(activeTripsResult.data || []),
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

  // Single shared realtime channel — AdminSidebar and Dashboard both use this hook.
  useEffect(() => registerSidebarCountsRealtime(() => fetchCounts(true)), [fetchCounts]);

  return { counts, isLoading, refresh: () => fetchCounts(true) };
}
