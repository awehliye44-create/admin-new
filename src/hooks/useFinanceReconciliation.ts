import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import type { FinanceSettlementSummaryResponse } from '@/components/finance/FinanceSettlementOverview';
import { invokeFinanceReconciliation } from '@/hooks/financeReconciliationApi';

export type OnecabSettlementStatus =
  | 'calculated_only'
  | 'pending_stripe_settlement'
  | 'available_in_stripe_balance'
  | 'paid_to_onecab_bank'
  | 'reconciled';

export type ReconciliationStatus =
  | 'BALANCED'
  | 'RECONCILIATION_MISMATCH'
  | 'balanced'
  | 'reconciliation_error';

export interface LedgerReconciliationCheck {
  expected_sum_pence: number;
  variance_pence: number;
  delta_pence: number;
  balanced: boolean;
  status: 'BALANCED' | 'RECONCILIATION_MISMATCH';
}

export interface FinanceReconciliationSummary {
  customer_revenue: {
    card_customer_revenue_pence: number;
    cash_collected_by_driver_pence: number;
    refunded_amount_pence: number;
    net_card_revenue_pence: number;
    total_customer_revenue_pence: number;
    net_customer_revenue_pence: number;
    commissionable_revenue_pence: number;
  };
  driver_money: {
    card_driver_payable_pence: number;
    cash_driver_already_received_pence: number;
    driver_wallet_balance_pence: number;
    driver_available_payout_pence: number;
    driver_pending_payout_pence: number;
    driver_paid_out_pence: number;
    driver_payout_liability_pence: number;
    onecab_cash_commission_owed_pence: number;
    in_flight_cashout_pence: number;
    driver_gross_earnings_pence?: number;
    driver_net_earnings_pence?: number;
  };
  onecab_money: {
    onecab_card_commission_pence: number;
    onecab_cash_commission_receivable_pence: number;
    onecab_gross_commission_pence: number;
    provider_processing_fee_pence: number;
    onecab_card_net_commission_pence: number;
    total_commission_earned_pence: number;
    net_platform_revenue_pence: number;
    onecab_net_commission_pence: number;
    onecab_bank_payout_pence: number;
    onecab_commission_status: OnecabSettlementStatus;
    onecab_commission_status_label: string;
  };
  provider_money: {
    provider_name: string;
    provider_available_balance_pence: number;
    provider_pending_balance_pence: number;
    provider_health_status: 'healthy' | 'degraded' | 'failing' | 'unknown';
    last_webhook_received_at: string | null;
  };
  reconciliation_check: {
    card_reconciliation: LedgerReconciliationCheck & {
      card_customer_revenue_pence: number;
      card_driver_payable_pence: number;
      onecab_card_commission_pence: number;
    };
    cash_reconciliation: LedgerReconciliationCheck & {
      cash_collected_by_driver_pence: number;
      cash_driver_already_received_pence: number;
      onecab_cash_commission_receivable_pence: number;
    };
    net_customer_revenue_pence: number;
    driver_paid_out_pence?: number;
    driver_remaining_liability_pence?: number;
    driver_net_earnings_pence: number;
    onecab_gross_commission_pence: number;
    onecab_net_commission_pence?: number;
    provider_processing_fee_pence: number;
    adjustments_pence: number;
    expected_sum_pence: number;
    variance_pence?: number;
    delta_pence: number;
    balanced: boolean;
    status: ReconciliationStatus;
  };
  ssot?: {
    version: string;
    data_source_badge: 'LIVE' | 'SUMMARY' | 'LEDGER' | 'RECONSTRUCTED';
    customer_revenue_source: string;
  };
}

export interface TripAuditStatusBadge {
  label: string;
  tone: 'green' | 'yellow' | 'blue' | 'orange' | 'gray' | 'red';
}

export interface TripFinancialAuditRow {
  trip_id: string;
  trip_code: string | null;
  date: string | null;
  driver_name: string | null;
  payment_method: string | null;
  customer_paid_pence: number;
  settlement_total_pence?: number;
  captured_pence: number;
  refunded_pence: number;
  net_customer_payment_pence: number;
  outstanding_pence?: number;
  capture_mismatch?: boolean;
  driver_net_pence: number | null;
  debt_recovered_pence?: number;
  available_payout_created_pence?: number | null;
  onecab_gross_commission_pence: number;
  processing_fee_pence: number;
  onecab_net_pence: number;
  driver_payout: TripAuditStatusBadge;
  onecab_commission: TripAuditStatusBadge;
  provider: TripAuditStatusBadge;
  /** @deprecated Use driver_payout.label */
  driver_payout_status?: string;
  /** @deprecated Use onecab_commission.label */
  onecab_commission_status?: string;
  /** @deprecated Use provider.label */
  provider_status?: string;
}

export interface LegacyManualReviewItem {
  payout_item_id: string;
  driver_id: string;
  amount_pence: number;
  completed_at: string | null;
  manual_review_reason: string | null;
  excluded_from_auto_allocation: boolean;
}

export interface FinanceReconciliationResponse {
  period: { from: string; to: string };
  currency_code: string;
  finance_reconciliation_summary: FinanceReconciliationSummary;
  trip_financial_audit: TripFinancialAuditRow[];
  legacy_manual_review_items?: LegacyManualReviewItem[];
  meta: {
    trip_count: number;
    audit_row_count: number;
    stripe_balance_error: string | null;
    accounting_rules: Record<string, string>;
  };
}

/** Map SSOT reconciliation payload to legacy settlement overview shape (embedded widgets). */
export function toSettlementOverviewResponse(data: FinanceReconciliationResponse): FinanceSettlementSummaryResponse {
  const s = data.finance_reconciliation_summary;
  const check = s.reconciliation_check;
  return {
    currency_code: data.currency_code,
    customer_revenue_summary: {
      total_customer_revenue_pence: s.customer_revenue.total_customer_revenue_pence,
      total_commissionable_revenue_pence: s.customer_revenue.commissionable_revenue_pence,
      trip_count: data.meta.trip_count,
    },
    driver_earnings_summary: {
      driver_gross_earnings_pence: s.driver_money.driver_gross_earnings_pence ?? 0,
      driver_net_earnings_pence: s.driver_money.card_driver_payable_pence,
    },
    onecab_commission_summary: {
      onecab_gross_commission_pence: s.onecab_money.total_commission_earned_pence ?? s.onecab_money.onecab_gross_commission_pence,
      stripe_fee_pence: s.onecab_money.provider_processing_fee_pence,
      onecab_net_pence: s.onecab_money.net_platform_revenue_pence ?? s.onecab_money.onecab_net_commission_pence,
      max_commission_at_15_percent_pence: Math.round(s.customer_revenue.commissionable_revenue_pence * 0.15),
      commission_exceeds_cap:
        s.onecab_money.onecab_gross_commission_pence >
        Math.round(s.customer_revenue.commissionable_revenue_pence * 0.15) + 5,
      pending_stripe_settlement_pence: s.provider_money.provider_pending_balance_pence,
      settlement_status: s.onecab_money.onecab_commission_status,
      settlement_status_label: s.onecab_money.onecab_commission_status_label,
      driver_payout_liability_pence: s.driver_money.driver_payout_liability_pence,
    },
    stripe_platform_summary: {
      available_platform_balance_pence: s.provider_money.provider_available_balance_pence,
      pending_platform_balance_pence: s.provider_money.provider_pending_balance_pence,
      unallocated_platform_cash_pence:
        s.provider_money.provider_available_balance_pence -
        s.driver_money.driver_payout_liability_pence -
        s.driver_money.in_flight_cashout_pence,
      error: data.meta.stripe_balance_error,
      note: 'Platform balance is total Stripe cash — NOT ONECAB commission',
    },
    driver_payout_summary: {
      wallet_balance_pence: s.driver_money.driver_wallet_balance_pence,
      available_payout_pence: s.driver_money.driver_available_payout_pence,
      pending_payout_pence: s.driver_money.driver_pending_payout_pence + s.driver_money.in_flight_cashout_pence,
      paid_out_pence: s.driver_money.driver_paid_out_pence,
      failed_amount_today_pence: 0,
      failure_reasons: [],
      safe_payout_amount_pence: s.driver_money.driver_available_payout_pence,
      waiting_for_stripe_funds:
        s.provider_money.provider_available_balance_pence < s.driver_money.driver_available_payout_pence,
    },
    reconciliation: {
      stripe_available_balance_pence: s.provider_money.provider_available_balance_pence,
      calculated_onecab_net_pence: s.onecab_money.onecab_card_net_commission_pence
        ?? Math.max(0, s.onecab_money.onecab_card_commission_pence - s.onecab_money.provider_processing_fee_pence),
      available_driver_payable_pence: s.driver_money.driver_payout_liability_pence,
      pending_transfers_pence: s.driver_money.in_flight_cashout_pence,
      unallocated_platform_cash_pence:
        s.provider_money.provider_available_balance_pence -
        s.driver_money.driver_payout_liability_pence -
        s.driver_money.in_flight_cashout_pence,
      reserves_or_adjustments_pence: check.delta_pence,
      reconciles: check.balanced,
      mismatch_warning: check.balanced ? null : `RECONCILIATION_MISMATCH — variance ${check.variance_pence ?? check.delta_pence}p`,
    },
    insufficient_funds_insight: null,
  };
}

export function useFinanceReconciliation(args?: {
  filter?: ServiceAreaFinanceSelection;
  from?: string;
  to?: string;
  enabled?: boolean;
  tripSearch?: string;
  tripSearchType?: 'code' | 'id';
}) {
  const { filter, from, to, enabled = true, tripSearch, tripSearchType } = args ?? {};
  const searchExtra = tripSearch
    ? {
        search: tripSearch,
        ...(tripSearchType === 'id' ? { search_type: 'id' } : {}),
      }
    : undefined;

  return useQuery<FinanceReconciliationResponse>({
    queryKey: [
      'finance-reconciliation-summary',
      filter?.regionId,
      filter?.serviceAreaId,
      from,
      to,
      tripSearch,
      tripSearchType,
    ],
    queryFn: () => invokeFinanceReconciliation(filter, from, to, searchExtra),
    enabled,
    staleTime: 30_000,
    refetchInterval: tripSearch ? false : 60_000,
    placeholderData: keepPreviousData,
    retry: 1,
    meta: { suppressErrorToast: true },
  });
}
