import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type CommissionStatus =
  | 'stripe_confirmed'
  | 'stripe_paid_out'
  | 'calculated_pending'
  | 'legacy_fallback';

export interface FinanceCurrencyGroup {
  currency_code: string;
  totals: {
    customer_revenue_pence: number;
    onecab_gross_commission_pence: number;
    stripe_fees_pence: number;
    onecab_net_commission_pence: number;
    driver_net_earnings_pence: number;
    driver_payout_liability_pence: number;
    driver_available_payout_pence: number;
    driver_pending_payout_pence: number;
    commissionable_revenue_pence: number;
  };
  commission_status: CommissionStatus;
  validation_warnings: string[];
}

export interface AdminFinanceSummary {
  max_tier_pct: number;
  stripe_platform_balance: {
    available_pence: number;
    pending_pence: number;
    source: 'stripe_api' | 'unavailable';
  };
  currencies: FinanceCurrencyGroup[];
}

/**
 * @deprecated Use `useFinancialReconciliationSSOT` — Financial Reconciliation is the SSOT.
 * This hook reads legacy `admin-finance-summary` (ledger aggregates) and must not be used for reporting.
 */
export function useAdminFinanceSummary(regionId?: string | null) {
  return useQuery<AdminFinanceSummary>({
    queryKey: ['admin-finance-summary', regionId || 'all'],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const path = regionId
        ? `admin-finance-summary?region_id=${regionId}`
        : 'admin-finance-summary';
      const { data, error } = await supabase.functions.invoke(path, { method: 'GET' });
      if (error) throw new Error(error.message || 'Failed to load finance summary');
      if (data?.error) throw new Error(data.error);
      return data as AdminFinanceSummary;
    },
  });
}
