import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import type {
  DriverStatementPeriodTotal,
  FinanceReconciliationResponse,
} from '@/hooks/useFinanceReconciliation';
import { supabase } from '@/integrations/supabase/client';
import { fetchEdgeFunctionGet } from '@/lib/fetchEdgeFunctionGet';

/** Build query params for admin-finance-reconciliation (Financial Reconciliation SSOT). */
export function buildFinanceReconciliationParams(
  filter?: ServiceAreaFinanceSelection,
  from?: string,
  to?: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const params: Record<string, string> = {};
  if (filter?.regionId) params.region_id = filter.regionId;
  else if (filter?.serviceAreaId) params.service_area_id = filter.serviceAreaId;
  if (from) params.from = from;
  if (to) params.to = to;
  if (extra) Object.assign(params, extra);
  return params;
}

/** @deprecated Use buildFinanceReconciliationParams + fetchEdgeFunctionGet */
export function buildFinanceReconciliationPath(
  filter?: ServiceAreaFinanceSelection,
  from?: string,
  to?: string,
  extra?: Record<string, string>,
): string {
  const params = buildFinanceReconciliationParams(filter, from, to, extra);
  const qs = new URLSearchParams(params).toString();
  return qs ? `admin-finance-reconciliation?${qs}` : 'admin-finance-reconciliation';
}

/** Invoke Financial Reconciliation SSOT edge function. */
export async function invokeFinanceReconciliation(
  filter?: ServiceAreaFinanceSelection,
  from?: string,
  to?: string,
  extra?: Record<string, string>,
): Promise<FinanceReconciliationResponse> {
  return fetchEdgeFunctionGet<FinanceReconciliationResponse>(
    'admin-finance-reconciliation',
    buildFinanceReconciliationParams(filter, from, to, extra),
  );
}

/** Read ONECAB net commission for a period — never compute locally. Returns null when SSOT field missing. */
export async function fetchOnecabNetCommissionPence(
  from: Date,
  to: Date,
  filter?: ServiceAreaFinanceSelection,
): Promise<number | null> {
  const data = await invokeFinanceReconciliation(filter, from.toISOString(), to.toISOString(), {
    summary_only: '1',
  });
  const net = data.finance_reconciliation_summary?.onecab_money?.onecab_net_commission_pence;
  return net == null ? null : net;
}

/** Per-driver statement totals for a period — SSOT backend aggregation only. */
export async function fetchDriverStatementPeriodTotals(
  filter: ServiceAreaFinanceSelection,
  from: string,
  to: string,
  driverIds: string[],
): Promise<DriverStatementPeriodTotal[]> {
  if (driverIds.length === 0) return [];
  const data = await invokeFinanceReconciliation(filter, from, to, {
    statement_totals: '1',
    driver_ids: driverIds.join(','),
    audit_limit: '10000',
  });
  return data.driver_statement_totals ?? [];
}

export type TripCaptureSsotRow = {
  trip_id: string;
  settlement_total_pence: number;
  capture_mismatch: boolean;
  captured_pence: number;
  ledger_trip_earning_net_pence: number | null;
};

/** Batch trip capture/settlement fields — SSOT via admin-get-trips-capture-ssot. */
export async function fetchTripsCaptureSsot(tripIds: string[]): Promise<TripCaptureSsotRow[]> {
  if (tripIds.length === 0) return [];
  const { data, error } = await supabase.functions.invoke('admin-get-trips-capture-ssot', {
    body: { trip_ids: tripIds },
  });
  if (error) throw error;
  if (!data?.success) throw new Error(data?.error ?? 'Capture SSOT fetch failed');
  return (data.trips ?? []) as TripCaptureSsotRow[];
}

export type OnecabProfitSsot = {
  platform_net_revenue_pence: number | null;
  expenses_pence: number;
  profit_before_tax_pence: number | null;
};

/** Platform profit before tax — backend SSOT (net revenue − expenses). */
export async function fetchOnecabProfitSsot(
  from: Date,
  to: Date,
  filter?: ServiceAreaFinanceSelection,
): Promise<OnecabProfitSsot> {
  const data = await invokeFinanceReconciliation(filter, from.toISOString(), to.toISOString(), {
    profit_ssot: '1',
    summary_only: '1',
  }) as FinanceReconciliationResponse & { profit_ssot?: OnecabProfitSsot };
  return data.profit_ssot ?? {
    platform_net_revenue_pence: null,
    expenses_pence: 0,
    profit_before_tax_pence: null,
  };
}
