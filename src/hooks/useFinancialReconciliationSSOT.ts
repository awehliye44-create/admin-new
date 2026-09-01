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

export type FinanceSsotStatus =
  | 'LIVE'
  | 'PARTIAL'
  | 'REFRESHING'
  | 'DEGRADED'
  | 'DEGRADED_SNAPSHOT'
  | 'READ_ONLY'
  | 'UNAVAILABLE';
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
  /** True while the heavy trip-audit payload is still loading (summary may already be shown). */
  isAuditLoading: boolean;
  /** True while a new period/scope audit is loading but placeholder rows from the prior scope are still held. */
  isAuditScopeTransition: boolean;
  /** True while summary KPIs for a new period/scope are loading but placeholder summary from the prior scope is still held. */
  isSummaryScopeTransition: boolean;
  auditError: Error | null;
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
  /**
   * summary — overview / drivers first paint (summary_only).
   * full — trip audit for Trips and Issues tabs.
   */
  auditMode?: 'summary' | 'full';
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
  mode: 'summary' | 'full';
}) {
  return [
    'finance-reconciliation-summary',
    args.filter?.regionId,
    args.filter?.serviceAreaId,
    args.from,
    args.to,
    args.tripSearch,
    args.tripSearchType,
    args.mode,
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

function liveOkFrom(data: FinanceReconciliationResponse | undefined, error: unknown): boolean {
  return !!pickSummary(data) && !error;
}

function livePartialFrom(data: FinanceReconciliationResponse | undefined): boolean {
  return (
    data?.status === 'PARTIAL'
    || String(data?.downstream_status?.provider ?? '').toUpperCase() === 'UNAVAILABLE'
    || String(data?.downstream_status?.payment_sessions ?? '').toUpperCase() === 'UNAVAILABLE'
    || String(data?.downstream_status?.wallet ?? '').toUpperCase() === 'UNAVAILABLE'
    || String(data?.downstream_status?.payouts ?? '').toUpperCase() === 'UNAVAILABLE'
  );
}

export function useFinancialReconciliationSSOT({
  filter,
  from,
  to,
  tripSearch,
  tripSearchType,
  enabled = true,
  auditMode = 'summary',
}: UseFinancialReconciliationSSOTArgs): FinancialReconciliationSSOTResult {
  const queryClient = useQueryClient();
  const scopeKey = snapshotScopeKey(filter.regionId, filter.serviceAreaId, from, to);
  const summaryKey = financeReconciliationQueryKey({
    filter, from, to, tripSearch, tripSearchType, mode: 'summary',
  });
  const fullKey = financeReconciliationQueryKey({
    filter, from, to, tripSearch, tripSearchType, mode: 'full',
  });

  const searchExtra = tripSearch
    ? {
        search: tripSearch,
        ...(tripSearchType === 'id' ? { search_type: 'id' } : {}),
      }
    : undefined;

  const summaryLive = useFinanceReconciliation({
    filter,
    from,
    to,
    tripSearch,
    tripSearchType,
    enabled,
    mode: 'summary',
  });

  const fullLive = useFinanceReconciliation({
    filter,
    from,
    to,
    tripSearch,
    tripSearchType,
    enabled: enabled && auditMode === 'full',
    mode: 'full',
  });

  const liveOkFull = liveOkFrom(fullLive.data, fullLive.error);
  const liveOkSummary = liveOkFrom(summaryLive.data, summaryLive.error);
  const liveOk = liveOkFull || liveOkSummary;
  const preferredData = liveOkFull ? fullLive.data : summaryLive.data;
  const livePartial = liveOk && preferredData ? livePartialFrom(preferredData) : false;

  useEffect(() => {
    if (liveOk && preferredData) {
      saveFinanceReconciliationSnapshot(preferredData, scopeKey);
    }
  }, [liveOk, preferredData, scopeKey]);

  const snapshot = useMemo(() => {
    if (liveOk) return null;
    return loadFinanceReconciliationSnapshot(scopeKey);
  }, [liveOk, summaryLive.dataUpdatedAt, summaryLive.errorUpdatedAt, fullLive.dataUpdatedAt, fullLive.errorUpdatedAt, scopeKey]);

  const refetchFresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['finance-reconciliation-summary'] });
    const mode = auditMode === 'full' ? 'full' : 'summary';
    const key = mode === 'full' ? fullKey : summaryKey;
    const fresh = await queryClient.fetchQuery({
      queryKey: key,
      queryFn: () =>
        invokeFinanceReconciliation(filter, from, to, {
          ...searchExtra,
          ...(mode === 'summary' ? { summary_only: '1' } : {}),
          _fresh: String(Date.now()),
        }),
      staleTime: 0,
    });
    clearFinanceReconciliationSnapshot();
    return fresh;
  }, [queryClient, summaryKey, fullKey, filter, from, to, searchExtra, auditMode]);

  const refetch = useCallback(async () => refetchFresh(), [refetchFresh]);

  // Never auto-refetch heavy finance queries on tab focus — Refresh only.

  const status: FinanceSsotStatus = liveOk
    ? (livePartial ? 'PARTIAL' : 'LIVE')
    : snapshot
      ? 'READ_ONLY'
      : 'UNAVAILABLE';

  const response =
    status === 'LIVE' || status === 'PARTIAL'
      ? preferredData ?? null
      : status === 'READ_ONLY'
        ? snapshot!.response
        : null;

  const rawSummary = pickSummary(response);
  const summary =
    rawSummary && status === 'READ_ONLY'
      ? applyDegradedReconciliationSummary(rawSummary)
      : rawSummary;

  const isLoading = (!enabled || summaryLive.isLoading) && status === 'UNAVAILABLE';
  const error =
    status === 'UNAVAILABLE'
      ? summaryLive.error instanceof Error
        ? summaryLive.error
        : summaryLive.error
          ? new Error(String(summaryLive.error))
          : new Error('Financial Reconciliation SSOT unavailable and no cached snapshot exists.')
      : null;

  const lastSyncedAt = pickLastSyncedAt(response) ?? response?.generated_at ?? null;
  const isFetching = summaryLive.isFetching || (auditMode === 'full' && fullLive.isFetching);
  const isAuditLoading = auditMode === 'full' && fullLive.isLoading && !fullLive.data;
  const isAuditScopeTransition =
    auditMode === 'full'
    && fullLive.isFetching
    && fullLive.isPlaceholderData;
  const isSummaryScopeTransition =
    summaryLive.isFetching
    && summaryLive.isPlaceholderData;
  const auditError =
    auditMode === 'full' && fullLive.error
      ? fullLive.error instanceof Error
        ? fullLive.error
        : new Error(String(fullLive.error))
      : null;

  const displayStatus: FinanceSsotStatus =
    isFetching && (status === 'LIVE' || status === 'PARTIAL')
      ? 'REFRESHING'
      : status === 'READ_ONLY'
        ? 'DEGRADED'
        : status;

  return {
    summary,
    response,
    status: displayStatus === 'DEGRADED' ? 'DEGRADED_SNAPSHOT' : status,
    badge: displayStatus === 'DEGRADED' ? 'DEGRADED' : displayStatus,
    isLive: status === 'LIVE' || status === 'PARTIAL',
    readOnly: status !== 'LIVE' && status !== 'PARTIAL',
    snapshotSavedAt: status === 'READ_ONLY' ? snapshot!.savedAt : null,
    lastSyncedAt,
    isLoading,
    isFetching,
    isAuditLoading,
    isAuditScopeTransition,
    isSummaryScopeTransition,
    auditError,
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
