/**
 * Financial Reconciliation SSOT — single hook for all admin finance reads.
 *
 * Priority 1: Financial Reconciliation Live (LIVE badge)
 * Priority 2: Driver Financial Summary (SUMMARY badge)
 * Priority 3: Driver Wallet Ledger aggregates (LEDGER badge)
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { buildFinanceReconciliationPath } from '@/hooks/financeReconciliationApi';
import {
  useFinanceReconciliation,
  type FinanceReconciliationResponse,
  type FinanceReconciliationSummary,
} from '@/hooks/useFinanceReconciliation';

export { buildFinanceReconciliationPath };

export type FinanceDataSourceBadge = 'LIVE' | 'SUMMARY' | 'LEDGER' | 'RECONSTRUCTED';

export type FinancialReconciliationSSOTResult = {
  summary: FinanceReconciliationSummary;
  badge: FinanceDataSourceBadge;
  currencyCode: string;
  period: { from: string; to: string };
  response: FinanceReconciliationResponse | null;
  isLive: boolean;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  refetch: () => void;
};

/** Fallback: aggregate driver_financial_summary when live reconciliation unavailable. */
async function fetchSummaryFallback(
  filter?: ServiceAreaFinanceSelection,
): Promise<FinanceReconciliationSummary | null> {
  let q = supabase
    .from('driver_financial_summary')
    .select(
      'wallet_balance, net_available_for_payout, total_payouts_sent, reserved_cashout_pence, company_commission_total, card_gross_total',
    );

  if (filter?.regionId) q = q.eq('region_id', filter.regionId);

  const { data, error } = await q;
  if (error || !data?.length) return null;

  const walletBalance = data.reduce((s, d) => s + Number(d.wallet_balance || 0), 0);
  const available = data.reduce((s, d) => s + Number(d.net_available_for_payout || 0), 0);
  const paidOut = data.reduce((s, d) => s + Number(d.total_payouts_sent || 0), 0);
  const reserved = data.reduce((s, d) => s + Number(d.reserved_cashout_pence || 0), 0);
  const commission = data.reduce((s, d) => s + Number(d.company_commission_total || 0), 0);

  return {
    customer_revenue: {
      card_customer_revenue_pence: 0,
      cash_collected_by_driver_pence: 0,
      refunded_amount_pence: 0,
      net_card_revenue_pence: 0,
      total_customer_revenue_pence: 0,
      net_customer_revenue_pence: 0,
      commissionable_revenue_pence: 0,
    },
    driver_money: {
      card_driver_payable_pence: 0,
      cash_driver_already_received_pence: 0,
      driver_wallet_balance_pence: walletBalance,
      driver_available_payout_pence: available,
      driver_pending_payout_pence: Math.max(0, walletBalance - available - paidOut),
      driver_paid_out_pence: paidOut,
      driver_payout_liability_pence: available + reserved,
      onecab_cash_commission_owed_pence: 0,
      in_flight_cashout_pence: reserved,
    },
    onecab_money: {
      onecab_card_commission_pence: commission,
      onecab_cash_commission_receivable_pence: 0,
      onecab_gross_commission_pence: commission,
      provider_processing_fee_pence: 0,
      onecab_card_net_commission_pence: commission,
      total_commission_earned_pence: commission,
      net_platform_revenue_pence: commission,
      onecab_net_commission_pence: commission,
      onecab_bank_payout_pence: 0,
      onecab_commission_status: 'calculated_only',
      onecab_commission_status_label: 'Summary fallback — run Financial Reconciliation for live values',
    },
    provider_money: {
      provider_name: 'Stripe',
      provider_available_balance_pence: 0,
      provider_pending_balance_pence: 0,
      provider_health_status: 'unknown',
      last_webhook_received_at: null,
    },
    reconciliation_check: emptySplitReconciliationCheck(paidOut, available + reserved, commission),
    ssot: {
      version: 'financial_reconciliation_ssot_v1',
      data_source_badge: 'SUMMARY',
      customer_revenue_source: 'driver_financial_summary',
    },
  };
}

const PAYOUT_DEBIT_LEDGER_TYPES = ['PAYOUT', 'WEEKLY_PAYOUT', 'EARLY_CASHOUT', 'MANUAL_PAYOUT'] as const;

function emptySplitReconciliationCheck(
  paidOut: number,
  liability: number,
  commission: number,
): FinanceReconciliationSummary['reconciliation_check'] {
  const balanced = { expected_sum_pence: 0, variance_pence: 0, delta_pence: 0, balanced: true, status: 'BALANCED' as const };
  return {
    card_reconciliation: { ...balanced, card_customer_revenue_pence: 0, card_driver_payable_pence: 0, onecab_card_commission_pence: 0 },
    cash_reconciliation: { ...balanced, cash_collected_by_driver_pence: 0, cash_driver_already_received_pence: 0, onecab_cash_commission_receivable_pence: 0 },
    net_customer_revenue_pence: 0,
    driver_paid_out_pence: paidOut,
    driver_remaining_liability_pence: liability,
    driver_net_earnings_pence: 0,
    onecab_gross_commission_pence: commission,
    onecab_net_commission_pence: commission,
    provider_processing_fee_pence: 0,
    adjustments_pence: 0,
    expected_sum_pence: 0,
    variance_pence: 0,
    delta_pence: 0,
    balanced: true,
    status: 'BALANCED',
  };
}

/** Fallback: aggregate driver_wallet_ledger when live reconciliation and summary view unavailable. */
async function fetchLedgerFallback(
  filter?: ServiceAreaFinanceSelection,
): Promise<FinanceReconciliationSummary | null> {
  let driverQuery = supabase.from('drivers').select('id');
  if (filter?.regionId) driverQuery = driverQuery.eq('region_id', filter.regionId);

  const { data: drivers, error: driversError } = await driverQuery;
  if (driversError || !drivers?.length) return null;

  const driverIds = drivers.map((d) => d.id);

  const [ledgerResult, walletsResult] = await Promise.all([
    supabase
      .from('driver_wallet_ledger')
      .select('type, amount_pence')
      .in('driver_id', driverIds),
    supabase
      .from('driver_wallets')
      .select('available_pence')
      .in('driver_id', driverIds),
  ]);

  if (ledgerResult.error || walletsResult.error) return null;

  const paidOut = Math.abs(
    (ledgerResult.data || [])
      .filter(
        (r) =>
          PAYOUT_DEBIT_LEDGER_TYPES.includes(r.type as (typeof PAYOUT_DEBIT_LEDGER_TYPES)[number])
          && Number(r.amount_pence) < 0,
      )
      .reduce((s, r) => s + Number(r.amount_pence || 0), 0),
  );
  const walletBalance = (walletsResult.data || []).reduce(
    (s, w) => s + Number(w.available_pence || 0),
    0,
  );

  return {
    customer_revenue: {
      card_customer_revenue_pence: 0,
      cash_collected_by_driver_pence: 0,
      refunded_amount_pence: 0,
      net_card_revenue_pence: 0,
      total_customer_revenue_pence: 0,
      net_customer_revenue_pence: 0,
      commissionable_revenue_pence: 0,
    },
    driver_money: {
      card_driver_payable_pence: 0,
      cash_driver_already_received_pence: 0,
      driver_wallet_balance_pence: walletBalance,
      driver_available_payout_pence: Math.max(0, walletBalance),
      driver_pending_payout_pence: 0,
      driver_paid_out_pence: paidOut,
      driver_payout_liability_pence: Math.max(0, walletBalance),
      onecab_cash_commission_owed_pence: 0,
      in_flight_cashout_pence: 0,
    },
    onecab_money: {
      onecab_card_commission_pence: 0,
      onecab_cash_commission_receivable_pence: 0,
      onecab_gross_commission_pence: 0,
      provider_processing_fee_pence: 0,
      onecab_card_net_commission_pence: 0,
      total_commission_earned_pence: 0,
      net_platform_revenue_pence: 0,
      onecab_net_commission_pence: 0,
      onecab_bank_payout_pence: 0,
      onecab_commission_status: 'calculated_only',
      onecab_commission_status_label: 'Ledger fallback — commission requires Financial Reconciliation',
    },
    provider_money: {
      provider_name: 'Stripe',
      provider_available_balance_pence: 0,
      provider_pending_balance_pence: 0,
      provider_health_status: 'unknown',
      last_webhook_received_at: null,
    },
    reconciliation_check: emptySplitReconciliationCheck(paidOut, Math.max(0, walletBalance), 0),
    ssot: {
      version: 'financial_reconciliation_ssot_v1',
      data_source_badge: 'LEDGER',
      customer_revenue_source: 'driver_wallet_ledger',
    },
  };
}

export function useFinancialReconciliationSSOT(args?: {
  filter?: ServiceAreaFinanceSelection;
  from?: string;
  to?: string;
  enabled?: boolean;
  tripSearch?: string;
  tripSearchType?: 'code' | 'id';
}): FinancialReconciliationSSOTResult {
  const { filter, from, to, enabled = true, tripSearch, tripSearchType } = args ?? {};

  const live = useFinanceReconciliation({ filter, from, to, enabled, tripSearch, tripSearchType });

  const liveUnavailable = !live.isLoading && !live.data?.finance_reconciliation_summary;

  const summaryFallback = useQuery({
    queryKey: ['finance-reconciliation-ssot-fallback', filter?.regionId, filter?.serviceAreaId],
    queryFn: () => fetchSummaryFallback(filter),
    enabled: enabled && liveUnavailable,
    staleTime: 60_000,
  });

  const ledgerFallback = useQuery({
    queryKey: ['finance-reconciliation-ssot-ledger', filter?.regionId, filter?.serviceAreaId],
    queryFn: () => fetchLedgerFallback(filter),
    enabled: enabled && liveUnavailable && !summaryFallback.isLoading && !summaryFallback.data,
    staleTime: 60_000,
  });

  const result = useMemo((): Omit<FinancialReconciliationSSOTResult, 'isLoading' | 'isFetching' | 'error' | 'refetch'> => {
    if (live.data?.finance_reconciliation_summary) {
      const badge = live.data.finance_reconciliation_summary.ssot?.data_source_badge ?? 'LIVE';
      return {
        summary: live.data.finance_reconciliation_summary,
        badge: badge as FinanceDataSourceBadge,
        currencyCode: live.data.currency_code,
        period: live.data.period,
        response: live.data,
        isLive: badge === 'LIVE',
      };
    }

    if (summaryFallback.data) {
      return {
        summary: summaryFallback.data,
        badge: 'SUMMARY',
        currencyCode: 'GBP',
        period: { from: from ?? '', to: to ?? '' },
        response: null,
        isLive: false,
      };
    }

    if (ledgerFallback.data) {
      return {
        summary: ledgerFallback.data,
        badge: 'LEDGER',
        currencyCode: 'GBP',
        period: { from: from ?? '', to: to ?? '' },
        response: null,
        isLive: false,
      };
    }

    return {
      summary: null as unknown as FinanceReconciliationSummary,
      badge: 'RECONSTRUCTED',
      currencyCode: 'GBP',
      period: { from: from ?? '', to: to ?? '' },
      response: null,
      isLive: false,
    };
  }, [live.data, summaryFallback.data, ledgerFallback.data, from, to]);

  const isLoading =
    live.isLoading
    || (liveUnavailable && summaryFallback.isLoading)
    || (liveUnavailable && !summaryFallback.data && ledgerFallback.isLoading);

  return {
    ...result,
    isLoading,
    isFetching: live.isFetching,
    error:
      (live.error as Error)
      ?? (summaryFallback.error as Error)
      ?? (ledgerFallback.error as Error)
      ?? null,
    refetch: () => {
      live.refetch();
      summaryFallback.refetch();
      ledgerFallback.refetch();
    },
  };
}

/** Read-only accessors — pages must use these, never compute locally. */
export const FinanceSSOT = {
  cardCustomerRevenue: (s: FinanceReconciliationSummary) => s.customer_revenue.card_customer_revenue_pence,
  cashCollectedByDriver: (s: FinanceReconciliationSummary) => s.customer_revenue.cash_collected_by_driver_pence,
  totalCustomerRevenue: (s: FinanceReconciliationSummary) => s.customer_revenue.total_customer_revenue_pence,
  refundedAmount: (s: FinanceReconciliationSummary) => s.customer_revenue.refunded_amount_pence,
  netCardRevenue: (s: FinanceReconciliationSummary) => s.customer_revenue.net_card_revenue_pence,
  netCustomerRevenue: (s: FinanceReconciliationSummary) => s.customer_revenue.net_card_revenue_pence,
  cardDriverPayable: (s: FinanceReconciliationSummary) => s.driver_money.card_driver_payable_pence,
  cashDriverAlreadyReceived: (s: FinanceReconciliationSummary) => s.driver_money.cash_driver_already_received_pence,
  driverGrossEarnings: (s: FinanceReconciliationSummary) => s.driver_money.driver_gross_earnings_pence ?? 0,
  driverNetEarnings: (s: FinanceReconciliationSummary) => s.driver_money.driver_net_earnings_pence ?? s.driver_money.card_driver_payable_pence,
  onecabCardCommission: (s: FinanceReconciliationSummary) => s.onecab_money.onecab_card_commission_pence,
  onecabCashCommissionReceivable: (s: FinanceReconciliationSummary) => s.onecab_money.onecab_cash_commission_receivable_pence,
  onecabGrossCommission: (s: FinanceReconciliationSummary) => s.onecab_money.onecab_gross_commission_pence,
  onecabCardNetCommission: (s: FinanceReconciliationSummary) =>
    s.onecab_money.onecab_card_net_commission_pence
    ?? Math.max(0, s.onecab_money.onecab_card_commission_pence - s.onecab_money.provider_processing_fee_pence),
  totalCommissionEarned: (s: FinanceReconciliationSummary) =>
    s.onecab_money.total_commission_earned_pence
    ?? (s.onecab_money.onecab_card_commission_pence + s.onecab_money.onecab_cash_commission_receivable_pence),
  providerProcessingFee: (s: FinanceReconciliationSummary) => s.onecab_money.provider_processing_fee_pence,
  netPlatformRevenue: (s: FinanceReconciliationSummary) =>
    s.onecab_money.net_platform_revenue_pence ?? s.onecab_money.onecab_net_commission_pence,
  onecabNetCommission: (s: FinanceReconciliationSummary) =>
    s.onecab_money.net_platform_revenue_pence ?? s.onecab_money.onecab_net_commission_pence,
  driverPaidOut: (s: FinanceReconciliationSummary) => s.driver_money.driver_paid_out_pence,
  driverRemainingLiability: (s: FinanceReconciliationSummary) => s.driver_money.driver_payout_liability_pence,
  driverAvailableNow: (s: FinanceReconciliationSummary) => s.driver_money.driver_available_payout_pence,
  driverPendingPayout: (s: FinanceReconciliationSummary) => s.driver_money.driver_pending_payout_pence,
  providerAvailableBalance: (s: FinanceReconciliationSummary) => s.provider_money.provider_available_balance_pence,
  providerPendingBalance: (s: FinanceReconciliationSummary) => s.provider_money.provider_pending_balance_pence,
  reconciliationStatus: (s: FinanceReconciliationSummary) =>
    s.reconciliation_check?.status ?? 'BALANCED',
  reconciliationVariance: (s: FinanceReconciliationSummary) =>
    s.reconciliation_check.variance_pence ?? s.reconciliation_check.delta_pence,
};
