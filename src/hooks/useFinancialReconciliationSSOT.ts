import { useCallback, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useFinanceReconciliation,
  type FinanceReconciliationResponse,
  type FinanceReconciliationSummary,
} from '@/hooks/useFinanceReconciliation';
import { invokeFinanceReconciliation } from '@/hooks/financeReconciliationApi';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { applyDegradedReconciliationSummary } from '@/lib/financialReconciliationDegraded';
import {
  clearFinanceReconciliationSnapshot,
  loadFinanceReconciliationSnapshot,
  saveFinanceReconciliationSnapshot,
  snapshotScopeKey,
} from '@/lib/financialReconciliationSnapshot';

export type FinanceSsotStatus = 'LIVE' | 'REFRESHING' | 'DEGRADED_SNAPSHOT' | 'UNAVAILABLE';
export type FinanceDataSourceBadge = FinanceSsotStatus;

export type FinancialReconciliationSSOTResult = {
  summary: FinanceReconciliationSummary | null;
  response: FinanceReconciliationResponse | null;
  status: FinanceSsotStatus;
  badge: FinanceSsotStatus;
  isLive: boolean;
  readOnly: boolean;
  snapshotSavedAt: string | null;
  lastSyncedAt: string | null;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
  refetchFresh: () => Promise<unknown>;
  currencyCode: string;
};

export type UseFinancialReconciliationSSOTArgs = {
  filter: ServiceAreaFinanceSelection;
  from?: string;
  to?: string;
  tripSearch?: string;
  tripSearchType?: 'code' | 'id';
  /** Wait until region/service scope is resolved before hitting admin-finance-reconciliation. */
  enabled?: boolean;
};

function nullableNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickSummary(response: FinanceReconciliationResponse | null | undefined): FinanceReconciliationSummary | null {
  return response?.finance_reconciliation_summary ?? null;
}

function financeReconciliationQueryKey(args: {
  filter: ServiceAreaFinanceSelection;
  from?: string;
  to?: string;
  tripSearch?: string;
  tripSearchType?: 'code' | 'id';
}) {
  return [
    'finance-reconciliation-summary',
    args.filter?.regionId,
    args.filter?.serviceAreaId,
    args.from,
    args.to,
    args.tripSearch,
    args.tripSearchType,
  ] as const;
}

function pickLastSyncedAt(response: FinanceReconciliationResponse | null | undefined): string | null {
  if (!response) return null;
  return (
    response.money_movement?.last_synced_at
    ?? response.finance_reconciliation_summary?.money_movement?.last_synced_at
    ?? null
  );
}

export function useFinancialReconciliationSSOT({
  filter,
  from,
  to,
  tripSearch,
  tripSearchType,
  enabled = true,
}: UseFinancialReconciliationSSOTArgs): FinancialReconciliationSSOTResult {
  const queryClient = useQueryClient();
  const scopeKey = snapshotScopeKey(filter.regionId, filter.serviceAreaId);
  const queryKey = financeReconciliationQueryKey({ filter, from, to, tripSearch, tripSearchType });

  const searchExtra = tripSearch
    ? {
        search: tripSearch,
        ...(tripSearchType === 'id' ? { search_type: 'id' } : {}),
      }
    : undefined;

  const live = useFinanceReconciliation({
    filter,
    from,
    to,
    tripSearch,
    tripSearchType,
    enabled,
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
    return loadFinanceReconciliationSnapshot(scopeKey);
  }, [liveOk, live.dataUpdatedAt, live.errorUpdatedAt, scopeKey]);

  const refetchFresh = useCallback(async () => {
    clearFinanceReconciliationSnapshot();
    await queryClient.invalidateQueries({ queryKey });
    return queryClient.fetchQuery({
      queryKey,
      queryFn: () =>
        invokeFinanceReconciliation(filter, from, to, {
          ...searchExtra,
          _fresh: String(Date.now()),
        }),
      staleTime: 0,
    });
  }, [queryClient, queryKey, filter, from, to, searchExtra]);

  const refetch = useCallback(async () => refetchFresh(), [refetchFresh]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      void queryClient.invalidateQueries({ queryKey });
      void live.refetch();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [queryClient, queryKey, live.refetch]);

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

  const isLoading = (!enabled || live.isLoading) && status === 'UNAVAILABLE';
  const error =
    status === 'UNAVAILABLE'
      ? live.error instanceof Error
        ? live.error
        : live.error
          ? new Error(String(live.error))
          : new Error('Financial Reconciliation SSOT unavailable and no cached snapshot exists.')
      : null;

  const lastSyncedAt = pickLastSyncedAt(response);

  const displayStatus: FinanceSsotStatus =
    live.isFetching && status === 'LIVE'
      ? 'REFRESHING'
      : status;

  return {
    summary,
    response,
    status,
    badge: displayStatus,
    isLive: status === 'LIVE',
    readOnly: status !== 'LIVE',
    snapshotSavedAt: status === 'DEGRADED_SNAPSHOT' ? snapshot!.savedAt : null,
    lastSyncedAt,
    isLoading,
    isFetching: live.isFetching,
    error,
    refetch,
    refetchFresh,
    currencyCode: response?.currency_code || filter.currencyCode || '',
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
