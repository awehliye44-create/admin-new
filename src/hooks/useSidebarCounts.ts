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
const REALTIME_REFETCH_DEBOUNCE_MS = 750;

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

/** One realtime channel + one in-flight fetch shared by all hook instances. */
let sidebarCountsChannel: RealtimeChannel | null = null;
let sharedCounts: SidebarCounts = defaultCounts;
let sharedLoading = true;
let fetchInFlight: Promise<SidebarCounts> | null = null;
let realtimeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const countListeners = new Set<(counts: SidebarCounts) => void>();
const loadingListeners = new Set<(loading: boolean) => void>();

function notifyCounts(counts: SidebarCounts) {
  sharedCounts = counts;
  countListeners.forEach((listener) => listener(counts));
}

function notifyLoading(loading: boolean) {
  sharedLoading = loading;
  loadingListeners.forEach((listener) => listener(loading));
}

async function fetchSidebarCountsOnce(skipCache = false): Promise<SidebarCounts> {
  if (fetchInFlight) return fetchInFlight;

  fetchInFlight = (async () => {
    if (!skipCache) {
      try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
          const parsed: CachedCounts = JSON.parse(cached);
          if (Date.now() - parsed.timestamp < CACHE_TTL_MS) {
            notifyCounts(parsed.data);
            notifyLoading(false);
            return parsed.data;
          }
        }
      } catch {
        // Ignore cache errors
      }
    }

    notifyLoading(true);

    try {
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
        supabase
          .from('trips')
          .select('id, status, searching_expires_at, driver_id, created_at, trip_code')
          .in('status', [...ACTIVE_TRIP_DB_STATUSES]),
        supabase
          .from('trips')
          .select('id', { count: 'exact', head: true })
          .eq('is_scheduled', true)
          .in('scheduled_status', ['pending', 'confirmed']),
        supabase
          .from('rider_feedback')
          .select('id', { count: 'exact', head: true })
          .in('status', ['pending', 'new']),
        supabase
          .from('documents')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),
        supabase
          .from('promo_codes')
          .select('id', { count: 'exact', head: true })
          .eq('is_active', true),
        supabase
          .from('admin_settings')
          .select('setting_value')
          .eq('setting_key', 'account_requests')
          .maybeSingle(),
        supabase
          .from('drivers')
          .select('id', { count: 'exact', head: true })
          .eq('approval_status', 'pending'),
        supabase
          .from('vehicle_change_requests')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),
      ]);

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

      localStorage.setItem(CACHE_KEY, JSON.stringify({
        data: newCounts,
        timestamp: Date.now(),
      }));
      notifyCounts(newCounts);
      return newCounts;
    } catch (error) {
      console.error('Error fetching sidebar counts:', error);
      return sharedCounts;
    } finally {
      notifyLoading(false);
      fetchInFlight = null;
    }
  })();

  return fetchInFlight;
}

function scheduleRealtimeRefetch() {
  if (realtimeDebounceTimer) return;
  realtimeDebounceTimer = setTimeout(() => {
    realtimeDebounceTimer = null;
    void fetchSidebarCountsOnce(true);
  }, REALTIME_REFETCH_DEBOUNCE_MS);
}

function ensureSidebarCountsRealtime() {
  if (sidebarCountsChannel) return;
  const channel = supabase.channel(`sidebar-counts-${crypto.randomUUID()}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'trips' }, scheduleRealtimeRefetch)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rider_feedback' }, scheduleRealtimeRefetch)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'documents' }, scheduleRealtimeRefetch)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'drivers' }, scheduleRealtimeRefetch)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'promo_codes' }, scheduleRealtimeRefetch)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'admin_settings' }, scheduleRealtimeRefetch)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'vehicle_change_requests' }, scheduleRealtimeRefetch);

  sidebarCountsChannel = channel;
  channel.subscribe((status) => {
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      if (sidebarCountsChannel === channel) {
        sidebarCountsChannel = null;
      }
    }
  });
}

let realtimeSubscriberCount = 0;

function registerSidebarCountsRealtime(): () => void {
  realtimeSubscriberCount += 1;
  ensureSidebarCountsRealtime();
  return () => {
    realtimeSubscriberCount -= 1;
    if (realtimeSubscriberCount <= 0 && sidebarCountsChannel) {
      supabase.removeChannel(sidebarCountsChannel);
      sidebarCountsChannel = null;
      realtimeSubscriberCount = 0;
    }
  };
}

export function useSidebarCounts() {
  const [counts, setCounts] = useState<SidebarCounts>(sharedCounts);
  const [isLoading, setIsLoading] = useState(sharedLoading);

  useEffect(() => {
    countListeners.add(setCounts);
    loadingListeners.add(setIsLoading);
    return () => {
      countListeners.delete(setCounts);
      loadingListeners.delete(setIsLoading);
    };
  }, []);

  const refresh = useCallback(() => fetchSidebarCountsOnce(true), []);

  useEffect(() => {
    void fetchSidebarCountsOnce();
  }, []);

  useEffect(() => {
    const handleFocus = () => {
      void fetchSidebarCountsOnce(true);
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  useEffect(() => registerSidebarCountsRealtime(), []);

  return { counts, isLoading, refresh };
}
