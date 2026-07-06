import { useQuery } from '@tanstack/react-query';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { fetchEdgeFunctionGet } from '@/lib/fetchEdgeFunctionGet';

export type FinanceBackendAuditV1 = {
  audit_version: 'finance_backend_audit_v1';
  period: { from: string; to: string };
  currency_code: string;
  incoming_money: {
    card_customer_revenue_pence?: number;
    net_card_revenue_pence?: number;
    customer_captured_total_pence: number;
    customer_refunded_total_pence: number;
    net_customer_money_in_pence: number;
    provider_available_balance_pence: number;
    provider_pending_balance_pence: number;
    provider_payouts_to_onecab_bank_pence: number;
  };
  paid_out: {
    driver_paid_out_total_pence: number;
    driver_weekly_payouts_paid_pence: number;
    driver_early_cashouts_paid_pence: number;
    failed_payouts_pence: number;
    onecab_paid_to_bank_pence: number;
    provider_fees_paid_pence: number;
  };
  remaining_money: {
    driver_remaining_liability_pence: number;
    driver_available_now_pence: number;
    driver_pending_settlement_pence: number;
    onecab_remaining_commission_pence: number;
    provider_available_balance_pence: number;
    provider_pending_balance_pence: number;
    reconciliation_difference_pence: number;
  };
  reconciliation: {
    reconciliation_status: 'BALANCED' | 'MISMATCH';
    reconciliation_difference_pence: number;
    card_reconciliation?: {
      card_customer_revenue_pence: number;
      card_driver_payable_pence: number;
      onecab_card_commission_pence: number;
      variance_pence: number;
      balanced: boolean;
      status: 'BALANCED' | 'MISMATCH';
    };
    equation: Record<string, number>;
  };
  answered_questions: Record<string, string | number>;
  trip_rows: Array<{
    trip_id: string;
    trip_code: string | null;
    captured_amount_pence: number;
    refunded_amount_pence: number;
    driver_net_pence: number;
    onecab_commission_pence: number;
    provider_fee_pence: number;
    payout_status: string;
    paid_out_amount_pence: number;
    remaining_driver_liability_pence: number;
  }>;
  payout_rows: Array<{
    payout_id: string;
    payout_source: string;
    driver_id: string;
    amount_pence: number;
    status: string;
    provider_reference: string | null;
    created_at: string | null;
    paid_at: string | null;
    ledger_entry_created: boolean;
    ledger_entry_id: string | null;
    ledger_amount_pence: number | null;
    batch_kind: string | null;
  }>;
  critical_checks: Array<{ id: string; passed: boolean; detail: string }>;
  wallet_integrity: Array<{
    driver_id: string;
    driver_name: string | null;
    wallet_balance_pence: number;
    ledger_sum_pence: number;
    wallet_ledger_drift_pence: number;
    completed_payouts_without_ledger_pence: number;
    explanation: string | null;
  }>;
  meta: {
    trip_count: number;
    payout_row_count: number;
    stripe_balance_error: string | null;
    accounting_rules: Record<string, string>;
  };
};

export type FinanceBackendAuditResponse = {
  finance_backend_audit_v1: FinanceBackendAuditV1;
  stripe_platform_payouts?: {
    paid_today_pence: number;
    paid_all_time_pence: number;
    recent: Array<{
      id: string;
      amount_pence: number;
      status: string;
      arrival_date: string | null;
      created_at: string;
    }>;
    note?: string;
  };
};

function buildAuditParams(
  filter?: ServiceAreaFinanceSelection,
  from?: string,
  to?: string,
  driverId?: string,
): Record<string, string> {
  const params: Record<string, string> = {};
  if (filter?.regionId) params.region_id = filter.regionId;
  else if (filter?.serviceAreaId) params.service_area_id = filter.serviceAreaId;
  if (from) params.from = from;
  if (to) params.to = to;
  if (driverId) params.driver_id = driverId;
  return params;
}

export function useFinanceBackendAudit(args?: {
  filter?: ServiceAreaFinanceSelection;
  from?: string;
  to?: string;
  driverId?: string;
  enabled?: boolean;
}) {
  const { filter, from, to, driverId, enabled = true } = args ?? {};
  return useQuery<FinanceBackendAuditResponse>({
    queryKey: ['finance-backend-audit-v1', filter?.regionId, filter?.serviceAreaId, from, to, driverId],
    queryFn: async () =>
      fetchEdgeFunctionGet<FinanceBackendAuditResponse>(
        'finance-backend-audit-v1',
        buildAuditParams(filter, from, to, driverId),
      ),
    enabled,
    staleTime: 30_000,
  });
}
