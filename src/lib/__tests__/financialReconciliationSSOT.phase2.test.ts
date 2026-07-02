import { describe, expect, it } from 'vitest';
import { FinanceSSOT } from '@/hooks/useFinancialReconciliationSSOT';
import type { FinanceReconciliationSummary } from '@/hooks/useFinanceReconciliation';

function summaryFallbackShape(walletBalancePence: number): FinanceReconciliationSummary {
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
      driver_wallet_balance_pence: walletBalancePence,
      driver_available_payout_pence: 0,
      driver_pending_payout_pence: 0,
      driver_paid_out_pence: 0,
      driver_payout_liability_pence: walletBalancePence,
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
      onecab_commission_status_label: 'test',
    },
    provider_money: {
      provider_name: 'Stripe',
      provider_available_balance_pence: 0,
      provider_pending_balance_pence: 0,
      provider_health_status: 'unknown',
      last_webhook_received_at: null,
    },
    reconciliation_check: {
      card_reconciliation: {
        card_customer_revenue_pence: 0,
        card_driver_payable_pence: 0,
        onecab_card_commission_pence: 0,
        expected_sum_pence: 0,
        variance_pence: 0,
        delta_pence: 0,
        balanced: true,
        status: 'BALANCED',
      },
      cash_reconciliation: {
        cash_collected_by_driver_pence: 0,
        cash_driver_already_received_pence: 0,
        onecab_cash_commission_receivable_pence: 0,
        expected_sum_pence: 0,
        variance_pence: 0,
        delta_pence: 0,
        balanced: true,
        status: 'BALANCED',
      },
      net_customer_revenue_pence: 0,
      driver_paid_out_pence: 0,
      driver_remaining_liability_pence: walletBalancePence,
      driver_net_earnings_pence: 0,
      onecab_gross_commission_pence: 0,
      onecab_net_commission_pence: 0,
      provider_processing_fee_pence: 0,
      adjustments_pence: 0,
      expected_sum_pence: 0,
      variance_pence: 0,
      delta_pence: 0,
      balanced: true,
      status: 'BALANCED',
    },
    ssot: {
      version: 'financial_reconciliation_ssot_v1',
      data_source_badge: 'SUMMARY',
      customer_revenue_source: 'driver_financial_summary',
    },
  };
}

describe('Phase 2 — admin FR SSOT fallbacks never derive payout from wallet', () => {
  it('wallet £9.73 liability does not expose £9.73 available payout', () => {
    const summary = summaryFallbackShape(973);
    expect(FinanceSSOT.driverRemainingLiability(summary)).toBe(973);
    expect(FinanceSSOT.driverAvailableNow(summary)).toBe(0);
    expect(FinanceSSOT.driverPendingPayout(summary)).toBe(0);
    expect(FinanceSSOT.driverPaidOut(summary)).toBe(0);
  });
});
