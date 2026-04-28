import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  startOfDay,
  endOfDay,
  startOfWeek,
  startOfMonth,
  subDays,
  format,
} from 'date-fns';

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

export interface LedgerRevenueResult {
  todayRevenue: number;
  weeklyRevenue: number;
  monthlyRevenue: number;
  allTimeRevenue: number;
  customRevenue: number;
  chartData: RevenueDataPoint[];
  serviceAreaBreakdown: ServiceAreaRevenueBreakdown[];
}

interface UseLedgerRevenueOptions {
  period: RevenuePeriod;
  serviceAreaId: string | null;
  customFrom?: Date;
  customTo?: Date;
  serviceAreas: { id: string; name: string; region?: { currency_code: string } | null }[];
}

/**
 * Revenue widgets show ONECAB NET revenue: commission_pence - stripe_processing_fee_pence.
 * Source: trips table (onecab_net_pence is persisted at capture; falls back to commission_pence
 * for historical trips that pre-date Stripe fee tracking).
 * Filtered to financially countable outcomes only (COMPLETED, NO_SHOW, LATE_PASSENGER_CANCELLATION).
 */
const COUNTABLE_OUTCOMES = ['COMPLETED', 'NO_SHOW', 'LATE_PASSENGER_CANCELLATION'];

type TripRow = {
  completed_at: string | null;
  service_area_id: string | null;
  commission_pence: number | null;
  stripe_processing_fee_pence: number | null;
  onecab_net_pence: number | null;
};

function netOf(r: Pick<TripRow, 'onecab_net_pence' | 'commission_pence' | 'stripe_processing_fee_pence'>): number {
  if (r.onecab_net_pence != null) return r.onecab_net_pence;
  return (r.commission_pence || 0) - (r.stripe_processing_fee_pence || 0);
}

async function fetchTrips(from: Date | null, to: Date | null, saId: string | null): Promise<TripRow[]> {
  let q = supabase
    .from('trips')
    .select('completed_at, service_area_id, commission_pence, stripe_processing_fee_pence, onecab_net_pence')
    .in('financial_outcome', COUNTABLE_OUTCOMES)
    .not('completed_at', 'is', null);
  if (from) q = q.gte('completed_at', from.toISOString());
  if (to) q = q.lte('completed_at', to.toISOString());
  if (saId) q = q.eq('service_area_id', saId);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []) as TripRow[];
}

function sumNet(rows: TripRow[]): number {
  return rows.reduce((s, r) => s + netOf(r), 0);
}

function bucketChart(rows: TripRow[], period: RevenuePeriod): RevenueDataPoint[] {
  const buckets = new Map<string, number>();
  for (const r of rows) {
    if (!r.completed_at) continue;
    const d = new Date(r.completed_at);
    let key: string;
    if (period === 'daily' || period === 'custom') {
      key = format(d, 'MMM d');
    } else if (period === 'weekly') {
      const weekStart = startOfWeek(d, { weekStartsOn: 1 });
      key = format(weekStart, 'MMM d');
    } else {
      key = format(d, 'MMM yyyy');
    }
    buckets.set(key, (buckets.get(key) || 0) + netOf(r));
  }
  return Array.from(buckets.entries()).map(([label, revenue]) => ({ label, revenue }));
}

export function useLedgerRevenue({
  period,
  serviceAreaId,
  customFrom,
  customTo,
  serviceAreas,
}: UseLedgerRevenueOptions) {
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

  return useQuery<LedgerRevenueResult>({
    queryKey: [
      'ledger-revenue-net',
      period,
      serviceAreaId,
      customFrom?.toISOString(),
      customTo?.toISOString(),
    ],
    queryFn: async () => {
      const saId = serviceAreaId || null;

      const [todayRows, weeklyRows, monthlyRows, allTimeRows, chartRows] = await Promise.all([
        fetchTrips(todayStart, todayEnd, saId),
        fetchTrips(weekStart, todayEnd, saId),
        fetchTrips(monthStart, todayEnd, saId),
        fetchTrips(null, null, saId),
        fetchTrips(chartFrom, chartTo, saId),
      ]);

      let customRev = 0;
      if (period === 'custom' && customFrom) {
        const cFrom = startOfDay(customFrom);
        const cTo = customTo ? endOfDay(customTo) : todayEnd;
        customRev = chartRows.reduce((s, r) => {
          if (!r.completed_at) return s;
          const t = new Date(r.completed_at).getTime();
          return t >= cFrom.getTime() && t <= cTo.getTime() ? s + netOf(r) : s;
        }, 0);
      }

      const chartData = bucketChart(chartRows, period);

      const saMap = new Map<string, number>();
      if (!saId) {
        for (const r of chartRows) {
          if (r.service_area_id) {
            saMap.set(r.service_area_id, (saMap.get(r.service_area_id) || 0) + netOf(r));
          }
        }
      }
      const serviceAreaBreakdown: ServiceAreaRevenueBreakdown[] = [];
      for (const [id, rev] of saMap.entries()) {
        const sa = serviceAreas.find(s => s.id === id);
        if (sa) {
          serviceAreaBreakdown.push({
            service_area_id: id,
            name: sa.name,
            revenue: rev,
            currency_code: sa.region?.currency_code || '',
          });
        }
      }
      serviceAreaBreakdown.sort((a, b) => b.revenue - a.revenue);

      return {
        todayRevenue: sumNet(todayRows),
        weeklyRevenue: sumNet(weeklyRows),
        monthlyRevenue: sumNet(monthlyRows),
        allTimeRevenue: sumNet(allTimeRows),
        customRevenue: customRev,
        chartData,
        serviceAreaBreakdown,
      };
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
