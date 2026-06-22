import { supabase } from '@/integrations/supabase/client';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import type { FinanceReconciliationResponse } from '@/hooks/useFinanceReconciliation';

/** Build admin-finance-reconciliation edge function path (Financial Reconciliation SSOT). */
export function buildFinanceReconciliationPath(
  filter?: ServiceAreaFinanceSelection,
  from?: string,
  to?: string,
  extra?: Record<string, string>,
): string {
  const params = new URLSearchParams();
  if (filter?.regionId) params.set('region_id', filter.regionId);
  else if (filter?.serviceAreaId) params.set('service_area_id', filter.serviceAreaId);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      params.set(key, value);
    }
  }
  const qs = params.toString();
  return qs ? `admin-finance-reconciliation?${qs}` : 'admin-finance-reconciliation';
}

/** Invoke Financial Reconciliation SSOT edge function. */
export async function invokeFinanceReconciliation(
  filter?: ServiceAreaFinanceSelection,
  from?: string,
  to?: string,
  extra?: Record<string, string>,
): Promise<FinanceReconciliationResponse> {
  const qs = buildFinanceReconciliationPath(filter, from, to, extra).split('?')[1] ?? '';
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token ?? anonKey;
  const url = `${supabaseUrl}/functions/v1/admin-finance-reconciliation${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Edge function returned ${res.status}: ${text}`);
  }
  return (await res.json()) as FinanceReconciliationResponse;
}

/** Read ONECAB net commission for a period — never compute locally. */
export async function fetchOnecabNetCommissionPence(
  from: Date,
  to: Date,
  serviceAreaId: string | null,
): Promise<number> {
  const filter = serviceAreaId ? { serviceAreaId, regionId: null, currencyCode: null } : undefined;
  const data = await invokeFinanceReconciliation(filter, from.toISOString(), to.toISOString());
  return data.finance_reconciliation_summary?.onecab_money?.onecab_net_commission_pence ?? 0;
}
