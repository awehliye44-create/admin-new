import { useQuery } from '@tanstack/react-query';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import type { TripFinancialAuditRow } from '@/hooks/useFinanceReconciliation';
import { fetchEdgeFunctionGet } from '@/lib/fetchEdgeFunctionGet';
import { tripDateInRange } from '@/lib/financialReconciliationDriverDateRange';

type FinanceAuditResponse = {
  trip_financial_audit?: TripFinancialAuditRow[];
  currency_code?: string;
};

export function useDriverTripFinancialAudit(args: {
  driverId: string | null;
  filter?: ServiceAreaFinanceSelection;
  from?: string;
  to?: string;
  enabled?: boolean;
}) {
  const { driverId, filter, from, to, enabled = true } = args;

  return useQuery({
    queryKey: ['driver-trip-financial-audit', driverId, filter?.regionId, filter?.serviceAreaId, from, to],
    queryFn: async (): Promise<TripFinancialAuditRow[]> => {
      if (!driverId || !from || !to) return [];
      const data = await fetchEdgeFunctionGet<FinanceAuditResponse>('admin-finance-reconciliation', {
        region_id: filter?.regionId ?? undefined,
        service_area_id: filter?.serviceAreaId ?? undefined,
        from,
        to,
        audit_limit: '10000',
      });
      const rows = data.trip_financial_audit ?? [];
      return rows.filter((row) => {
        if (row.driver_id !== driverId) return false;
        const dateIso = row.date ?? row.created_at;
        return tripDateInRange(dateIso, from, to);
      });
    },
    enabled: enabled && !!driverId && !!from && !!to,
    staleTime: 30_000,
  });
}
