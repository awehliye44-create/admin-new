import { useEffect, useMemo } from 'react';
import {
  useFinanceReconciliation,
  type FinanceReconciliationResponse,
  type FinanceReconciliationSummary,
} from '@/hooks/useFinanceReconciliation';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { applyDegradedReconciliationSummary } from '@/lib/financialReconciliationDegraded';
import {
  loadFinanceReconciliationSnapshot,
  saveFinanceReconciliationSnapshot,
  snapshotScopeKey,
} from '@/lib/financialReconciliationSnapshot';

export type FinanceSsotStatus = 'LIVE' | 'DEGRADED_SNAPSHOT' | 'UNAVAILABLE';
export type FinanceDataSourceBadge = FinanceSsotStatus;

export type FinancialReconciliationSSOTResult = {
  summary: FinanceReconciliationSummary | null;
  response: FinanceReconciliationResponse | null;
  status: FinanceSsotStatus;
  badge: FinanceSsotStatus;
  isLive: boolean;
  readOnly: boolean;
  snapshotSavedAt: string | null;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  refetch: () => void;
  currencyCode: string;
};

export type UseFinancialReconciliationSSOTArgs = {
  filter: ServiceAreaFinanceSelection;
  from?: string;
  to?: string;
  tripSearch?: string;
  tripSearchType?: 'code' | 'id';
};

function nullableNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickSummary(response: FinanceReconciliationResponse | null | undefined): FinanceReconciliationSummary | null {
  return response?.finance_reconciliation_summary ?? null;
}

export function useFinancialReconciliationSSOT({
  filter,
  from,
  to,
  tripSearch,
  tripSearchType,
}: UseFinancialReconciliationSSOTArgs): FinancialReconciliationSSOTResult {
  const scopeKey = snapshotScopeKey(filter.regionId, filter.serviceAreaId);

  const live = useFinanceReconciliation({
    filter,
    from,
    to,
    tripSearch,
    tripSearchType,
    enabled: true,
  });

  const liveSummary = pickSummary(live.data);
  const liveOk = !!liveSummary && !live.error;

  useEffect(() => {
    if (liveOk && live.data) {
      saveFinanceReconciliationSnapshot(live.data, scopeKey);
    }
  }, [liveOk, live.data, scopeKey]);

  const snapshot = useMemo(() => {
    if (liveOk) return null;
    return loadFinanceReconciliationSnapshot();
  }, [liveOk, live.dataUpdatedAt, live.errorUpdatedAt]);

  const status: FinanceSsotStatus = liveOk
    ? 'LIVE'
    : snapshot
      ? 'DEGRADED_SNAPSHOT'
      : 'UNAVAILABLE';

  const response =
    status === 'LIVE'
      ? live.data ?? null
      : status === 'DEGRADED_SNAPSHOT'
        ? snapshot!.response
        : null;

  const rawSummary = pickSummary(response);
  const summary =
    rawSummary && status === 'DEGRADED_SNAPSHOT'
      ? applyDegradedReconciliationSummary(rawSummary)
      : rawSummary;

  const isLoading = live.isLoading && status === 'UNAVAILABLE';
  const error =
    status === 'UNAVAILABLE'
      ? live.error instanceof Error
        ? live.error
        : live.error
          ? new Error(String(live.error))
          : new Error('Financial Reconciliation SSOT unavailable and no cached snapshot exists.')
      : null;

  return {
    summary,
    response,
    status,
    badge: status,
    isLive: status === 'LIVE',
    readOnly: status !== 'LIVE',
    snapshotSavedAt: status === 'DEGRADED_SNAPSHOT' ? snapshot!.savedAt : null,
    isLoading,
    isFetching: live.isFetching,
    error,
    refetch: () => void live.refetch(),
    currencyCode: filter.currencyCode || response?.currency_code || 'GBP',
  };
}

/** Shared accessors for summary blocks (used by overview + alerts). */
export const FinanceSSOT = {
  customerRevenue: (s: FinanceReconciliationSummary) => s.customer_revenue,
  driverMoney: (s: FinanceReconciliationSummary) => s.driver_money,
  onecabMoney: (s: FinanceReconciliationSummary) => s.onecab_money,
  providerMoney: (s: FinanceReconciliationSummary) => s.provider_money,
  reconciliationCheck: (s: FinanceReconciliationSummary) => s.reconciliation_check,
  netCustomerRevenue: (s: FinanceReconciliationSummary) =>
    nullableNum(s.customer_revenue?.net_customer_revenue_pence),
  driverWalletBalance: (s: FinanceReconciliationSummary) =>
    nullableNum(s.driver_money?.driver_wallet_balance_pence),
  driverAvailableNow: (s: FinanceReconciliationSummary) =>
    nullableNum(s.driver_money?.driver_available_payout_pence),
  driverPendingPayout: (s: FinanceReconciliationSummary) =>
    nullableNum(s.driver_money?.driver_pending_payout_pence),
  driverPaidOut: (s: FinanceReconciliationSummary) => nullableNum(s.driver_money?.driver_paid_out_pence),
  driverRemainingLiability: (s: FinanceReconciliationSummary) =>
    nullableNum(s.reconciliation_check?.driver_remaining_liability_pence),
  onecabGrossCommission: (s: FinanceReconciliationSummary) =>
    nullableNum(s.onecab_money?.onecab_gross_commission_pence),
  onecabNetCommission: (s: FinanceReconciliationSummary) =>
    nullableNum(s.onecab_money?.onecab_net_commission_pence),
  providerAvailable: (s: FinanceReconciliationSummary) =>
    nullableNum(s.provider_money?.provider_available_balance_pence),
  providerPending: (s: FinanceReconciliationSummary) =>
    nullableNum(s.provider_money?.provider_pending_balance_pence),
};
