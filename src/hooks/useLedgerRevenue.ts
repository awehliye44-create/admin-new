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
  revenue: number; // pence
}

export interface ServiceAreaRevenueBreakdown {
  service_area_id: string;
  name: string;
  revenue: number; // pence
  currency_code: string;
}

export interface LedgerRevenueResult {
  todayRevenue: number;
  weeklyRevenue: number;
  monthlyRevenue: number;
  customRevenue: number;
  chartData: RevenueDataPoint[];
  serviceAreaBreakdown: ServiceAreaRevenueBreakdown[];
}

interface UseLedgerRevenueOptions {
  period: RevenuePeriod;
  serviceAreaId: string | null; // null = all
  customFrom?: Date;
  customTo?: Date;
  serviceAreas: { id: string; name: string; region?: { currency_code: string } | null }[];
}

const COMMISSION_TYPE = 'COMPANY_COMMISSION';

async function fetchSum(from: Date, to: Date, saId: string | null): Promise<number> {
  let q = supabase
    .from('driver_wallet_ledger')
    .select('amount_pence')
    .eq('type', COMMISSION_TYPE)
    .gte('created_at', from.toISOString())
    .lte('created_at', to.toISOString());

  if (saId) q = q.eq('service_area_id', saId);

  const { data, error } = await q;
  if (error) throw error;
  return (data || []).reduce((s, r) => s + (r.amount_pence || 0), 0);
}

async function fetchGrouped(
  from: Date,
  to: Date,
  saId: string | null
): Promise<{ created_at: string; amount_pence: number }[]> {
  let q = supabase
    .from('driver_wallet_ledger')
    .select('created_at, amount_pence')
    .eq('type', COMMISSION_TYPE)
    .gte('created_at', from.toISOString())
    .lte('created_at', to.toISOString())
    .order('created_at', { ascending: true });

  if (saId) q = q.eq('service_area_id', saId);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function fetchByServiceArea(
  from: Date,
  to: Date
): Promise<{ service_area_id: string; amount_pence: number }[]> {
  const { data, error } = await supabase
    .from('driver_wallet_ledger')
    .select('service_area_id, amount_pence')
    .eq('type', COMMISSION_TYPE)
    .gte('created_at', from.toISOString())
    .lte('created_at', to.toISOString())
    .not('service_area_id', 'is', null);

  if (error) throw error;
  return data || [];
}

function bucketChart(
  rows: { created_at: string; amount_pence: number }[],
  period: RevenuePeriod
): RevenueDataPoint[] {
  const buckets = new Map<string, number>();

  for (const r of rows) {
    const d = new Date(r.created_at);
    let key: string;
    if (period === 'daily' || period === 'custom') {
      key = format(d, 'MMM d');
    } else if (period === 'weekly') {
      const weekStart = startOfWeek(d, { weekStartsOn: 1 });
      key = format(weekStart, 'MMM d');
    } else {
      key = format(d, 'MMM yyyy');
    }
    buckets.set(key, (buckets.get(key) || 0) + (r.amount_pence || 0));
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

  // Chart range depends on period
  let chartFrom: Date;
  let chartTo: Date = todayEnd;
  if (period === 'custom' && customFrom) {
    chartFrom = startOfDay(customFrom);
    chartTo = customTo ? endOfDay(customTo) : todayEnd;
  } else if (period === 'monthly') {
    chartFrom = startOfMonth(subDays(monthStart, 90)); // ~3 months
  } else if (period === 'weekly') {
    chartFrom = startOfWeek(subDays(now, 28), { weekStartsOn: 1 }); // 4 weeks
  } else {
    chartFrom = subDays(todayStart, 7); // last 7 days
  }

  return useQuery<LedgerRevenueResult>({
    queryKey: [
      'ledger-revenue',
      period,
      serviceAreaId,
      customFrom?.toISOString(),
      customTo?.toISOString(),
    ],
    queryFn: async () => {
      const saId = serviceAreaId || null;

      const [todayRev, weeklyRev, monthlyRev, chartRows, saRows] = await Promise.all([
        fetchSum(todayStart, todayEnd, saId),
        fetchSum(weekStart, todayEnd, saId),
        fetchSum(monthStart, todayEnd, saId),
        fetchGrouped(chartFrom, chartTo, saId),
        saId ? Promise.resolve([]) : fetchByServiceArea(chartFrom, chartTo),
      ]);

      // Custom revenue
      let customRev = 0;
      if (period === 'custom' && customFrom) {
        const cFrom = startOfDay(customFrom);
        const cTo = customTo ? endOfDay(customTo) : todayEnd;
        customRev = chartRows.reduce((s, r) => {
          const t = new Date(r.created_at).getTime();
          return t >= cFrom.getTime() && t <= cTo.getTime()
            ? s + (r.amount_pence || 0)
            : s;
        }, 0);
      }

      const chartData = bucketChart(chartRows, period);

      // Build SA breakdown
      const saMap = new Map<string, number>();
      for (const r of saRows) {
        if (r.service_area_id) {
          saMap.set(r.service_area_id, (saMap.get(r.service_area_id) || 0) + (r.amount_pence || 0));
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
        todayRevenue: todayRev,
        weeklyRevenue: weeklyRev,
        monthlyRevenue: monthlyRev,
        customRevenue: customRev,
        chartData,
        serviceAreaBreakdown,
      };
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
