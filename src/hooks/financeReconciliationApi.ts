import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import type { FinanceReconciliationResponse } from '@/hooks/useFinanceReconciliation';
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

/** Read ONECAB net commission for a period — never compute locally. */
export async function fetchOnecabNetCommissionPence(
  from: Date,
  to: Date,
  serviceAreaId: string | null,
): Promise<number> {
  try {
    const filter = serviceAreaId ? { serviceAreaId, regionId: null, currencyCode: null } : undefined;
    const data = await invokeFinanceReconciliation(filter, from.toISOString(), to.toISOString(), {
      summary_only: '1',
    });
    return data.finance_reconciliation_summary?.onecab_money?.onecab_net_commission_pence ?? 0;
  } catch (error) {
    console.warn('[fetchOnecabNetCommissionPence]', error);
    return 0;
  }
}
