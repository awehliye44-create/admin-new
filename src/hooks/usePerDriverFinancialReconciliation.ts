import { useQuery } from '@tanstack/react-query';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import type { FinanceDataSourceBadge } from '@/hooks/useFinancialReconciliationSSOT';
import { fetchEdgeFunctionGet } from '@/lib/fetchEdgeFunctionGet';

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
  finance_cleared_amount_pence?: number;
  eligible_payout_pence?: number;
  included_in_payout_batch_pence?: number;
  stripe_paid_out_total_pence?: number;
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
  reconciliation_scope?: 'digital' | 'digital_v3' | 'split';
  reconciliation_variance_pence?: number;
  digital_net_customer_revenue_pence?: number;
  digital_onecab_net_commission_pence?: number;
  digital_provider_processing_fee_pence?: number;
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
      return fetchEdgeFunctionGet<PerDriverFinanceSSOTResponse>(
        'admin-finance-reconciliation',
        {
          driver_id: driverId,
          region_id: filter?.regionId ?? undefined,
          from,
          to,
        },
      );
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
