import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import type { FinanceSettlementSummaryResponse } from '@/components/finance/FinanceSettlementOverview';

export type OnecabSettlementStatus =
  | 'calculated_only'
  | 'pending_stripe_settlement'
  | 'available_in_stripe_balance'
  | 'paid_to_onecab_bank'
  | 'reconciled';

export type ReconciliationStatus = 'balanced' | 'reconciliation_error';

export interface FinanceReconciliationSummary {
  customer_revenue: {
    total_customer_revenue_pence: number;
    refunded_amount_pence: number;
    net_customer_revenue_pence: number;
    commissionable_revenue_pence: number;
  };
  driver_money: {
    driver_gross_earnings_pence: number;
    driver_net_earnings_pence: number;
    driver_wallet_balance_pence: number;
    driver_available_payout_pence: number;
    driver_pending_payout_pence: number;
    driver_paid_out_pence: number;
    driver_payout_liability_pence: number;
    in_flight_cashout_pence: number;
  };
  onecab_money: {
    onecab_gross_commission_pence: number;
    provider_processing_fee_pence: number;
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
    net_customer_revenue_pence: number;
    driver_net_earnings_pence: number;
    onecab_gross_commission_pence: number;
    provider_processing_fee_pence: number;
    adjustments_pence: number;
    expected_sum_pence: number;
    delta_pence: number;
    balanced: boolean;
    status: ReconciliationStatus;
  };
}

export interface TripFinancialAuditRow {
  trip_id: string;
  trip_code: string | null;
  date: string | null;
  driver_name: string | null;
  customer_paid_pence: number;
  captured_pence: number;
  refunded_pence: number;
  net_customer_payment_pence: number;
  driver_net_pence: number;
  onecab_gross_commission_pence: number;
  processing_fee_pence: number;
  onecab_net_pence: number;
  driver_payout_status: string;
  onecab_commission_status: string;
  provider_status: string;
}

export interface FinanceReconciliationResponse {
  period: { from: string; to: string };
  currency_code: string;
  finance_reconciliation_summary: FinanceReconciliationSummary;
  trip_financial_audit: TripFinancialAuditRow[];
  meta: {
    trip_count: number;
    audit_row_count: number;
    stripe_balance_error: string | null;
    accounting_rules: Record<string, string>;
  };
}

function buildReconciliationPath(filter?: ServiceAreaFinanceSelection, from?: string, to?: string): string {
  const params = new URLSearchParams();
  if (filter?.regionId) params.set('region_id', filter.regionId);
  else if (filter?.serviceAreaId) params.set('service_area_id', filter.serviceAreaId);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const qs = params.toString();
  return qs ? `admin-finance-reconciliation?${qs}` : 'admin-finance-reconciliation';
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
      driver_gross_earnings_pence: s.driver_money.driver_gross_earnings_pence,
      driver_net_earnings_pence: s.driver_money.driver_net_earnings_pence,
    },
    onecab_commission_summary: {
      onecab_gross_commission_pence: s.onecab_money.onecab_gross_commission_pence,
      stripe_fee_pence: s.onecab_money.provider_processing_fee_pence,
      onecab_net_pence: s.onecab_money.onecab_net_commission_pence,
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
      calculated_onecab_net_pence: s.onecab_money.onecab_net_commission_pence,
      available_driver_payable_pence: s.driver_money.driver_payout_liability_pence,
      pending_transfers_pence: s.driver_money.in_flight_cashout_pence,
      unallocated_platform_cash_pence:
        s.provider_money.provider_available_balance_pence -
        s.driver_money.driver_payout_liability_pence -
        s.driver_money.in_flight_cashout_pence,
      reserves_or_adjustments_pence: check.delta_pence,
      reconciles: check.balanced,
      mismatch_warning: check.balanced ? null : 'Reconciliation Error — customer revenue does not match trip split.',
    },
    insufficient_funds_insight: null,
  };
}

export function useFinanceReconciliation(args?: {
  filter?: ServiceAreaFinanceSelection;
  from?: string;
  to?: string;
  enabled?: boolean;
}) {
  const { filter, from, to, enabled = true } = args ?? {};
  return useQuery<FinanceReconciliationResponse>({
    queryKey: ['finance-reconciliation-summary', filter?.regionId, filter?.serviceAreaId, from, to],
    queryFn: async () => {
      const path = buildReconciliationPath(filter, from, to);
      const { data, error } = await supabase.functions.invoke(path, { method: 'GET' });
      if (error) throw error;
      return data as FinanceReconciliationResponse;
    },
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
