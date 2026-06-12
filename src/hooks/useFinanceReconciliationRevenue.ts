import { useQuery } from '@tanstack/react-query';
import {
  startOfDay,
  endOfDay,
  startOfWeek,
  startOfMonth,
  subDays,
  format,
} from 'date-fns';
import {
  fetchOnecabNetCommissionPence,
  invokeFinanceReconciliation,
} from '@/hooks/financeReconciliationApi';

export type RevenuePeriod = 'daily' | 'weekly' | 'monthly' | 'custom';

export interface RevenueDataPoint {
  label: string;
  revenue: number;
}

export interface ServiceAreaRevenueBreakdown {
  service_area_id: string;
  name: string;
  revenue: number;
  currency_code: string;
}

export interface FinanceReconciliationRevenueResult {
  todayRevenue: number;
  weeklyRevenue: number;
  monthlyRevenue: number;
  allTimeRevenue: number;
  customRevenue: number;
  chartData: RevenueDataPoint[];
  serviceAreaBreakdown: ServiceAreaRevenueBreakdown[];
  dataSourceBadge: 'LIVE';
}

interface UseFinanceReconciliationRevenueOptions {
  period: RevenuePeriod;
  serviceAreaId: string | null;
  customFrom?: Date;
  customTo?: Date;
  serviceAreas: { id: string; name: string; region?: { currency_code: string } | null }[];
}

function bucketAuditChart(
  rows: Array<{ date: string | null; onecab_net_pence: number }>,
  period: RevenuePeriod,
): RevenueDataPoint[] {
  const buckets = new Map<string, number>();
  for (const row of rows) {
    if (!row.date) continue;
    const d = new Date(row.date);
    let key: string;
    if (period === 'daily' || period === 'custom') {
      key = format(d, 'MMM d');
    } else if (period === 'weekly') {
      key = format(startOfWeek(d, { weekStartsOn: 1 }), 'MMM d');
    } else {
      key = format(d, 'MMM yyyy');
    }
    buckets.set(key, (buckets.get(key) || 0) + row.onecab_net_pence);
  }
  return Array.from(buckets.entries()).map(([label, revenue]) => ({ label, revenue }));
}

/**
 * Period-based ONECAB net commission for dashboard widgets.
 * All values come from Financial Reconciliation SSOT (`admin-finance-reconciliation`).
 */
export function useFinanceReconciliationRevenue({
  period,
  serviceAreaId,
  customFrom,
  customTo,
  serviceAreas,
}: UseFinanceReconciliationRevenueOptions) {
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const monthStart = startOfMonth(now);

  let chartFrom: Date;
  let chartTo: Date = todayEnd;
  if (period === 'custom' && customFrom) {
    chartFrom = startOfDay(customFrom);
    chartTo = customTo ? endOfDay(customTo) : todayEnd;
  } else if (period === 'monthly') {
    chartFrom = startOfMonth(subDays(monthStart, 90));
  } else if (period === 'weekly') {
    chartFrom = startOfWeek(subDays(now, 28), { weekStartsOn: 1 });
  } else {
    chartFrom = subDays(todayStart, 7);
  }

  return useQuery<FinanceReconciliationRevenueResult>({
    queryKey: [
      'finance-reconciliation-revenue-ssot',
      period,
      serviceAreaId,
      customFrom?.toISOString(),
      customTo?.toISOString(),
    ],
    queryFn: async () => {
      const saId = serviceAreaId || null;
      const epochStart = new Date('2020-01-01');
      const filter = saId ? { serviceAreaId: saId, regionId: null, currencyCode: null } : undefined;

      const [todayNet, weeklyNet, monthlyNet, allTimeNet, chartResponse] = await Promise.all([
        fetchOnecabNetCommissionPence(todayStart, todayEnd, saId),
        fetchOnecabNetCommissionPence(weekStart, todayEnd, saId),
        fetchOnecabNetCommissionPence(monthStart, todayEnd, saId),
        fetchOnecabNetCommissionPence(epochStart, todayEnd, saId),
        invokeFinanceReconciliation(filter, chartFrom.toISOString(), chartTo.toISOString(), {
          audit_limit: '500',
        }),
      ]);

      let customRev = 0;
      if (period === 'custom' && customFrom) {
        const cFrom = startOfDay(customFrom);
        const cTo = customTo ? endOfDay(customTo) : todayEnd;
        customRev = await fetchOnecabNetCommissionPence(cFrom, cTo, saId);
      }

      const auditRows = chartResponse.trip_financial_audit ?? [];
      const chartData = bucketAuditChart(auditRows, period);

      const serviceAreaBreakdown: ServiceAreaRevenueBreakdown[] = [];
      if (!saId) {
        for (const sa of serviceAreas) {
          const net = await fetchOnecabNetCommissionPence(chartFrom, chartTo, sa.id);
          if (net > 0) {
            serviceAreaBreakdown.push({
              service_area_id: sa.id,
              name: sa.name,
              revenue: net,
              currency_code: sa.region?.currency_code || '',
            });
          }
        }
        serviceAreaBreakdown.sort((a, b) => b.revenue - a.revenue);
      }

      return {
        todayRevenue: todayNet,
        weeklyRevenue: weeklyNet,
        monthlyRevenue: monthlyNet,
        allTimeRevenue: allTimeNet,
        customRevenue: customRev,
        chartData,
        serviceAreaBreakdown,
        dataSourceBadge: 'LIVE' as const,
      };
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
