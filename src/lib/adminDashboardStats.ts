import { supabase } from '@/integrations/supabase/client';
import { ACTIVE_TRIP_DB_STATUSES } from '@/lib/activeTripStatuses';
import { filterAdminActiveTrips } from '@/lib/adminActiveTripFilter';
import { ADMIN_DASHBOARD_CHART_ROW_CAP } from '@/lib/adminQueryBounds';

export type DashboardPeriodStats = {
  totalDrivers: number;
  onlineDrivers: number;
  offlineDrivers: number;
  pendingDrivers: number;
  inactiveDrivers: number;
  /** Online drivers currently assigned to a trip. */
  onTripDrivers: number;
  /** Online drivers with no current_trip_id. */
  availableOnlineDrivers: number;
  totalRiders: number;
  totalTrips: number;
  activeTrips: number;
  inProgressTrips: number;
  completedTrips: number;
  cancelledTrips: number;
};

export type DashboardChartRow = {
  status: string | null;
  created_at: string;
};

type TripCountScope = {
  startIso: string;
  endIso: string;
  serviceAreaId: string | 'all';
};

async function tripHeadCount(
  scope: TripCountScope,
  status?: string | readonly string[],
): Promise<number> {
  let q = supabase
    .from('trips')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', scope.startIso)
    .lte('created_at', scope.endIso);
  if (scope.serviceAreaId !== 'all') {
    q = q.eq('service_area_id', scope.serviceAreaId);
  }
  if (typeof status === 'string') {
    q = q.eq('status', status);
  } else if (status && status.length > 0) {
    q = q.in('status', [...status]);
  }
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

async function driversHeadCount(
  filter?: { column: string; value: string | boolean },
): Promise<number> {
  let q: any = supabase.from('drivers').select('id', { count: 'exact', head: true });
  if (filter) {
    q = q.eq(filter.column, filter.value);
  }
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

/**
 * Operational dashboard KPIs via head counts + a small active-trip hydrate.
 * Never downloads up to 10k period trip rows or the full drivers table.
 */
export async function fetchDashboardPeriodStats(
  scope: TripCountScope,
): Promise<DashboardPeriodStats> {
  const inProgressStatuses = [
    'in_progress',
    'started',
    'on_trip',
    'ongoing',
    'trip_started',
  ] as const;

  const [
    totalDrivers,
    onlineDrivers,
    pendingDrivers,
    inactiveDrivers,
    onTripR,
    availableOnlineR,
    ridersR,
    totalTrips,
    completedTrips,
    cancelledTrips,
    inProgressTrips,
    activeRowsR,
  ] = await Promise.all([
    driversHeadCount(),
    driversHeadCount({ column: 'is_online', value: true }),
    driversHeadCount({ column: 'approval_status', value: 'pending' }),
    driversHeadCount({ column: 'approval_status', value: 'rejected' }),
    supabase
      .from('drivers')
      .select('id', { count: 'exact', head: true })
      .eq('is_online', true)
      .not('current_trip_id', 'is', null),
    supabase
      .from('drivers')
      .select('id', { count: 'exact', head: true })
      .eq('is_online', true)
      .is('current_trip_id', null),
    supabase.from('customers').select('id', { count: 'exact', head: true }),
    tripHeadCount(scope),
    tripHeadCount(scope, 'completed'),
    tripHeadCount(scope, 'cancelled'),
    tripHeadCount(scope, inProgressStatuses),
    (async () => {
      let q = supabase
        .from('trips')
        .select('id, status, searching_expires_at, created_at')
        .in('status', [...ACTIVE_TRIP_DB_STATUSES])
        .order('created_at', { ascending: false })
        .limit(500);
      if (scope.serviceAreaId !== 'all') {
        q = q.eq('service_area_id', scope.serviceAreaId);
      }
      return q;
    })(),
  ]);

  if (ridersR.error) throw ridersR.error;
  if (onTripR.error) throw onTripR.error;
  if (availableOnlineR.error) throw availableOnlineR.error;
  if (activeRowsR.error) throw activeRowsR.error;

  const activeTrips = filterAdminActiveTrips(activeRowsR.data || []).length;
  const offlineDrivers = Math.max(0, totalDrivers - onlineDrivers);

  return {
    totalDrivers,
    onlineDrivers,
    offlineDrivers,
    pendingDrivers,
    inactiveDrivers,
    onTripDrivers: onTripR.count ?? 0,
    availableOnlineDrivers: availableOnlineR.count ?? 0,
    totalRiders: ridersR.count ?? 0,
    totalTrips,
    activeTrips,
    inProgressTrips,
    completedTrips,
    cancelledTrips,
  };
}

/**
 * Chart series rows — bounded hydrate within the chart window.
 * Ordered newest-first so the cap prefers recent activity.
 */
export async function fetchDashboardChartRows(args: {
  startIso: string;
  endIso: string;
  serviceAreaId: string | 'all';
}): Promise<DashboardChartRow[]> {
  let q = supabase
    .from('trips')
    .select('status, created_at')
    .gte('created_at', args.startIso)
    .lte('created_at', args.endIso)
    .in('status', ['completed', 'cancelled'])
    .order('created_at', { ascending: false })
    .limit(ADMIN_DASHBOARD_CHART_ROW_CAP);
  if (args.serviceAreaId !== 'all') {
    q = q.eq('service_area_id', args.serviceAreaId);
  }
  const { data, error } = await q;
  if (error) throw error;
  return (data || []) as DashboardChartRow[];
}
