import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';

export type FinanceBackendAuditV1 = {
  audit_version: 'finance_backend_audit_v1';
  period: { from: string; to: string };
  currency_code: string;
  incoming_money: {
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
};

function buildAuditPath(
  filter?: ServiceAreaFinanceSelection,
  from?: string,
  to?: string,
  driverId?: string,
): string {
  const params = new URLSearchParams();
  if (filter?.regionId) params.set('region_id', filter.regionId);
  else if (filter?.serviceAreaId) params.set('service_area_id', filter.serviceAreaId);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (driverId) params.set('driver_id', driverId);
  const qs = params.toString();
  return qs ? `finance-backend-audit-v1?${qs}` : 'finance-backend-audit-v1';
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
    queryFn: async () => {
      const path = buildAuditPath(filter, from, to, driverId);
      const { data, error } = await supabase.functions.invoke(path, { method: 'GET' });
      if (error) throw error;
      return data as FinanceBackendAuditResponse;
    },
    enabled,
    staleTime: 30_000,
  });
}
