import type { FinanceReconciliationSummary } from '@/hooks/useFinanceReconciliation';

const EMPTY_LEDGER_CHECK = {
  expected_sum_pence: 0,
  variance_pence: 0,
  delta_pence: 0,
  balanced: true,
  status: 'BALANCED' as const,
  card_customer_revenue_pence: 0,
  card_driver_payable_pence: 0,
  onecab_card_commission_pence: 0,
  cash_collected_by_driver_pence: 0,
  cash_driver_already_received_pence: 0,
  onecab_cash_commission_receivable_pence: 0,
};

export function safeReconciliationCheck(
  summary: FinanceReconciliationSummary | null | undefined,
): FinanceReconciliationSummary['reconciliation_check'] {
  const check = summary?.reconciliation_check;
  if (!check) {
    return {
      ...EMPTY_LEDGER_CHECK,
      card_reconciliation: { ...EMPTY_LEDGER_CHECK },
      cash_reconciliation: { ...EMPTY_LEDGER_CHECK },
      net_customer_revenue_pence: 0,
      driver_net_earnings_pence: 0,
      onecab_gross_commission_pence: 0,
      provider_processing_fee_pence: 0,
      adjustments_pence: 0,
      balanced: true,
      status: 'BALANCED',
    };
  }
  return {
    ...check,
    card_reconciliation: check.card_reconciliation ?? { ...EMPTY_LEDGER_CHECK },
    cash_reconciliation: check.cash_reconciliation ?? { ...EMPTY_LEDGER_CHECK },
    balanced: check.balanced ?? true,
    status: check.status ?? 'BALANCED',
  };
}

export function safeReconciliationStatus(summary: FinanceReconciliationSummary | null | undefined): string {
  return safeReconciliationCheck(summary).status ?? 'BALANCED';
}

export function safeCustomerRevenue(summary: FinanceReconciliationSummary | null | undefined) {
  return summary?.customer_revenue ?? {
    card_customer_revenue_pence: 0,
    cash_collected_by_driver_pence: 0,
    refunded_amount_pence: 0,
    net_card_revenue_pence: 0,
    total_customer_revenue_pence: 0,
    net_customer_revenue_pence: 0,
    commissionable_revenue_pence: 0,
  };
}

export function safeDriverMoney(summary: FinanceReconciliationSummary | null | undefined) {
  return summary?.driver_money ?? {
    card_driver_payable_pence: 0,
    cash_driver_already_received_pence: 0,
    driver_wallet_balance_pence: 0,
    driver_available_payout_pence: 0,
    driver_pending_payout_pence: 0,
    driver_paid_out_pence: 0,
    driver_payout_liability_pence: 0,
    onecab_cash_commission_owed_pence: 0,
    in_flight_cashout_pence: 0,
  };
}

export function safeOnecabMoney(summary: FinanceReconciliationSummary | null | undefined) {
  return summary?.onecab_money ?? {
    onecab_card_commission_pence: 0,
    onecab_cash_commission_receivable_pence: 0,
    onecab_gross_commission_pence: 0,
    provider_processing_fee_pence: 0,
    onecab_card_net_commission_pence: 0,
    total_commission_earned_pence: 0,
    net_platform_revenue_pence: 0,
    onecab_net_commission_pence: 0,
    onecab_bank_payout_pence: 0,
    onecab_commission_status: 'calculated_only' as const,
    onecab_commission_status_label: 'Unavailable',
  };
}

export function safeProviderMoney(summary: FinanceReconciliationSummary | null | undefined) {
  return summary?.provider_money ?? {
    provider_name: 'Stripe',
    provider_available_balance_pence: 0,
    provider_pending_balance_pence: 0,
    provider_health_status: 'unknown' as const,
    last_webhook_received_at: null,
  };
}
