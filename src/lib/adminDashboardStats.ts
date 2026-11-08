import {
  adminDashboardChartRowsRpc,
  adminDashboardPeriodStatsRpc,
} from '@/lib/adminPageGatedData';
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

/**
 * Operational dashboard KPIs via page-gated RPC (dashboard page).
 * Never downloads up to 10k period trip rows or the full drivers table.
 */
export async function fetchDashboardPeriodStats(
  scope: TripCountScope,
): Promise<DashboardPeriodStats> {
  const raw = await adminDashboardPeriodStatsRpc({
    startIso: scope.startIso,
    endIso: scope.endIso,
    serviceAreaId: scope.serviceAreaId,
  });

  const activeTripRows = (Array.isArray(raw.activeTripRows) ? raw.activeTripRows : []) as Array<{
    id?: string;
    status?: string | null;
    searching_expires_at?: string | null;
    created_at?: string;
  }>;
  const activeTrips = filterAdminActiveTrips(activeTripRows).length;

  return {
    totalDrivers: Number(raw.totalDrivers ?? 0),
    onlineDrivers: Number(raw.onlineDrivers ?? 0),
    offlineDrivers: Number(raw.offlineDrivers ?? 0),
    pendingDrivers: Number(raw.pendingDrivers ?? 0),
    inactiveDrivers: Number(raw.inactiveDrivers ?? 0),
    onTripDrivers: Number(raw.onTripDrivers ?? 0),
    availableOnlineDrivers: Number(raw.availableOnlineDrivers ?? 0),
    totalRiders: Number(raw.totalRiders ?? 0),
    totalTrips: Number(raw.totalTrips ?? 0),
    activeTrips,
    inProgressTrips: Number(raw.inProgressTrips ?? 0),
    completedTrips: Number(raw.completedTrips ?? 0),
    cancelledTrips: Number(raw.cancelledTrips ?? 0),
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
  return adminDashboardChartRowsRpc({
    startIso: args.startIso,
    endIso: args.endIso,
    serviceAreaId: args.serviceAreaId,
    limit: ADMIN_DASHBOARD_CHART_ROW_CAP,
  });
}
