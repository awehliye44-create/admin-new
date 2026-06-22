import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import type { FinanceDataSourceBadge } from '@/hooks/useFinancialReconciliationSSOT';

export type PerDriverFinanceSSOT = {
  driver_id: string;
  driver_gross_earnings_pence: number;
  driver_net_earnings_pence: number;
  driver_paid_out_pence: number;
  completed_early_cashouts_pence: number;
  adjustments_pence: number;
  driver_remaining_liability_pence: number;
  in_flight_cashout_pence: number;
  provider_available_balance_pence: number;
  provider_pending_balance_pence: number;
  provider_available_balance_allocated_to_driver_pence: number;
  provider_upcoming_payout_pence: number;
  driver_available_now_pence: number;
  driver_pending_payout_pence: number;
  driver_wallet_balance_pence: number;
  driver_debt_pence: number;
  next_payout_date: string | null;
  reconciliation_status: 'BALANCED' | 'RECONCILIATION_MISMATCH';
  source_tier: FinanceDataSourceBadge;
  ledger_sync_missing: boolean;
  payout_blocked: boolean;
  payout_blocked_reasons: string[];
  payout_warning_reasons: string[];
  reconciliation_scope?: 'digital' | 'split';
  reconciliation_variance_pence?: number;
};

export type PerDriverFinanceSSOTResponse = {
  period: { from: string; to: string };
  currency_code: string;
  finance_reconciliation_driver_ssot: PerDriverFinanceSSOT;
  meta?: {
    driver_id: string;
    ssot_version: string;
    data_source_badge: FinanceDataSourceBadge;
    stripe_balance_error: string | null;
  };
};

function buildPerDriverPath(
  driverId: string,
  filter?: ServiceAreaFinanceSelection,
  from?: string,
  to?: string,
): string {
  const params = new URLSearchParams({ driver_id: driverId });
  if (filter?.regionId) params.set('region_id', filter.regionId);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return `admin-finance-reconciliation?${params.toString()}`;
}

export function usePerDriverFinancialReconciliation(args: {
  driverId: string | null;
  filter?: ServiceAreaFinanceSelection;
  from?: string;
  to?: string;
  enabled?: boolean;
}) {
  const { driverId, filter, from, to, enabled = true } = args;

  return useQuery<PerDriverFinanceSSOTResponse>({
    queryKey: ['per-driver-finance-ssot', driverId, filter?.regionId, from, to],
    queryFn: async () => {
      if (!driverId) throw new Error('driver_id required');
      const path = buildPerDriverPath(driverId, filter, from, to);
      const { data, error } = await supabase.functions.invoke(path, { method: 'GET' });
      if (error) throw error;
      return data as PerDriverFinanceSSOTResponse;
    },
    enabled: enabled && !!driverId,
    staleTime: 30_000,
  });
}

export const PerDriverSSOT = {
  availableNow: (s: PerDriverFinanceSSOT) => s.driver_available_now_pence,
  pendingPayout: (s: PerDriverFinanceSSOT) => s.driver_pending_payout_pence,
  remainingLiability: (s: PerDriverFinanceSSOT) => s.driver_remaining_liability_pence,
  canPayout: (s: PerDriverFinanceSSOT) =>
    !s.payout_blocked && !s.ledger_sync_missing && s.driver_available_now_pence > 0,
  hasSoftWarning: (s: PerDriverFinanceSSOT) => (s.payout_warning_reasons?.length ?? 0) > 0,
};
