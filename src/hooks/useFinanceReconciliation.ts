import { useQuery } from '@tanstack/react-query';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { invokeFinanceReconciliation } from '@/hooks/financeReconciliationApi';

export type OnecabSettlementStatus =
  | 'calculated_only'
  | 'pending_stripe_settlement'
  | 'available_in_stripe_balance'
  | 'paid_to_onecab_bank'
  | 'reconciled';

/** @deprecated Legacy settlement overview shape — use FinanceReconciliationSummary directly. */
export interface FinanceSettlementSummaryResponse {
  currency_code: string;
  customer_revenue_summary: {
    total_customer_revenue_pence: number;
    total_commissionable_revenue_pence: number;
    trip_count: number;
  };
  driver_earnings_summary: {
    driver_gross_earnings_pence: number;
    driver_net_earnings_pence: number;
  };
  onecab_commission_summary: {
    onecab_gross_commission_pence: number;
    stripe_fee_pence: number;
    onecab_net_pence: number;
    max_commission_at_15_percent_pence: number;
    commission_exceeds_cap: boolean;
    pending_stripe_settlement_pence: number;
    settlement_status: OnecabSettlementStatus;
    settlement_status_label: string;
    driver_payout_liability_pence: number;
  };
  stripe_platform_summary: {
    available_platform_balance_pence: number;
    pending_platform_balance_pence: number;
    error: string | null;
    note: string;
  };
  driver_payout_summary: {
    wallet_balance_pence: number;
    available_payout_pence: number;
    pending_payout_pence: number;
    paid_out_pence: number;
    failed_amount_today_pence: number;
    failure_reasons: Array<{ reason: string; amount_pence: number; count: number }>;
    safe_payout_amount_pence: number;
    waiting_for_stripe_funds: boolean;
  };
  reconciliation: {
    stripe_available_balance_pence: number;
    calculated_onecab_net_pence: number;
    available_driver_payable_pence: number;
    pending_transfers_pence: number;
    reserves_or_adjustments_pence: number;
    reconciles: boolean;
    mismatch_warning: string | null;
  };
  insufficient_funds_insight: {
    reason: string | null;
    requested_driver_payout_pence: number;
    stripe_available_balance_at_review_pence: number;
    calculated_onecab_net_pence: number;
    diagnoses: string[];
    why_commission_showed_but_payout_failed: string[];
  } | null;
}

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
    refunded_amount_pence: number;
    net_card_revenue_pence: number;
    total_customer_revenue_pence: number;
    net_customer_revenue_pence: number;
    commissionable_revenue_pence: number;
  };
  driver_money: {
    card_driver_payable_pence: number;
    driver_wallet_balance_pence: number;
    driver_available_payout_pence: number;
    driver_pending_payout_pence: number;
    driver_paid_out_pence: number;
    driver_payout_liability_pence: number;
    driver_gross_earnings_pence?: number;
    driver_net_earnings_pence?: number;
    in_flight_cashout_pence?: number;
  };
  onecab_money: {
    onecab_card_commission_pence: number;
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
    data_source_badge: 'LIVE' | 'DEGRADED_SNAPSHOT' | 'UNAVAILABLE';
    customer_revenue_source: string;
  };
  pending_stripe_confirmation?: {
    label: string;
    trip_count: number;
    expected_revenue_pence: number;
    expected_commission_pence: number;
    expected_driver_net_pence: number;
  };
  money_movement?: ConnectMoneyMovementBundle;
}

export type MoneyMovementReconciliationStatus =
  | 'pending_stripe_confirmation'
  | 'matched'
  | 'mismatch'
  | 'refunded_reversed'
  | 'paid_out';

export interface ConnectMoneyMovementBundle {
  version: string;
  last_synced_at: string;
  connect_accounts: Array<{
    connected_account_id: string;
    driver_id: string;
    driver_name: string;
    driver_code: string | null;
    stripe_live_balance_pence: number;
    future_payout_pence: number;
    in_transit_to_bank_pence: number;
    lifetime_volume_pence: number;
    last_synced_at: string;
    duplicate_connect_account: boolean;
    duplicate_connect_group_key: string | null;
    expected_wallet_balance_pence: number;
    actual_stripe_balance_pence: number;
    difference_pence: number;
    recovery_debt_pence: number;
    net_payable_after_recovery_pence: number;
    reconciliation_status: MoneyMovementReconciliationStatus;
    currency_code?: string;
  }>;
  payouts: Array<{
    connected_account_id: string;
    driver_id: string;
    driver_name: string;
    driver_code: string | null;
    stripe_live_balance_pence: number;
    future_payout_pence: number;
    in_transit_to_bank_pence: number;
    lifetime_volume_pence: number;
    payout_id: string;
    payout_amount_pence: number;
    payout_status: string;
    payout_initiated_at: string | null;
    estimated_arrival_at: string | null;
    external_bank_last4: string | null;
    payout_method: string;
    statement_descriptor: string | null;
    last_synced_at: string;
    expected_ledger_pence: number | null;
    actual_stripe_pence: number;
    difference_pence: number;
    reconciliation_status: MoneyMovementReconciliationStatus;
    ledger_entry_ids: string[];
    ledger_linked: boolean;
    duplicate_connect_account: boolean;
    duplicate_connect_group_key: string | null;
  }>;
  transfers: Array<{
    transfer_id: string;
    connected_account_id: string;
    driver_id: string;
    driver_name: string;
    amount_pence: number;
    trip_id: string | null;
    created_at: string | null;
    reconciliation_status: MoneyMovementReconciliationStatus;
  }>;
  collected_fees: Array<{
    connected_account_id: string;
    driver_id: string;
    driver_name: string;
    application_fee_id: string | null;
    charge_id: string | null;
    trip_id: string | null;
    amount_pence: number;
    created_at: string | null;
  }>;
  recovery_debt: Array<{
    driver_id: string;
    driver_name: string;
    connected_account_id: string | null;
    recovery_debt_pence: number;
    ledger_types: string[];
    reduces_net_payable: boolean;
    note: string;
  }>;
  mismatches: Array<{
    kind: string;
    driver_id: string | null;
    driver_name: string | null;
    connected_account_id: string | null;
    reference_id: string | null;
    expected_pence: number | null;
    actual_pence: number | null;
    difference_pence: number;
    status: MoneyMovementReconciliationStatus;
    message: string;
  }>;
  duplicate_connect_groups: Array<{
    group_key: string;
    driver_ids: string[];
    connected_account_ids: string[];
    driver_names: string[];
  }>;
}

export interface TripAuditStatusBadge {
  label: string;
  tone: 'green' | 'yellow' | 'blue' | 'orange' | 'gray' | 'red';
}

export interface PlatformReconciliationKpis {
  balanced_drivers: number;
  outstanding_liability_pence: number;
  failed_payouts_pence: number;
  stripe_only_records: number;
  provider_only_records?: number;
  ledger_only_records: number;
  todays_captures_pence: number;
  todays_card_trips: number;
  driver_count: number;
}

export interface TripFinancialAuditRow {
  trip_id: string;
  trip_code: string | null;
  date: string | null;
  driver_id: string | null;
  customer_name: string | null;
  driver_name: string | null;
  payment_method: string | null;
  stripe_payment_intent_id?: string | null;
  customer_paid_pence: number | null;
  gross_fare_pence?: number | null;
  discount_pence?: number | null;
  final_fare_pence?: number | null;
  settlement_total_pence?: number | null;
  captured_pence: number | null;
  refunded_pence: number | null;
  net_customer_payment_pence: number | null;
  outstanding_pence?: number | null;
  capture_mismatch?: boolean;
  driver_net_pence: number | null;
  debt_recovered_pence?: number | null;
  available_payout_created_pence?: number | null;
  onecab_gross_commission_pence: number | null;
  processing_fee_pence: number | null;
  onecab_net_pence: number | null;
  driver_payout: TripAuditStatusBadge;
  onecab_commission: TripAuditStatusBadge;
  provider: TripAuditStatusBadge;
  currency_code?: string | null;
  /** @deprecated Use driver_payout.label */
  driver_payout_status?: string;
  /** @deprecated Use onecab_commission.label */
  onecab_commission_status?: string;
  /** @deprecated Use provider.label */
  provider_status?: string;
  trip_status?: string | null;
  financial_outcome?: string | null;
  created_at?: string | null;
  payment_status?: string | null;
  capture_status?: string | null;
  reconciliation_status?: TripAuditStatusBadge;
}

export interface LegacyManualReviewItem {
  payout_item_id: string;
  driver_id: string;
  amount_pence: number;
  completed_at: string | null;
  manual_review_reason: string | null;
  excluded_from_auto_allocation: boolean;
}

export interface StripePaymentIntentAuditRow {
  payment_intent_id: string;
  trip_id: string | null;
  trip_code: string | null;
  driver_id: string | null;
  customer_name: string | null;
  driver_name: string | null;
  captured_pence: number;
  status: string;
  date: string | null;
}

export interface DriverStatementPeriodTotal {
  driver_id: string;
  gross_earnings_pence: number;
  commission_pence: number;
  driver_net_pence: number;
  completed_trips: number;
  no_show_trips: number;
  late_cancel_trips: number;
  bonuses_pence: number;
  penalties_pence: number;
  adjustments_pence: number;
  net_earnings_pence: number;
  payouts_received_pence: number;
}

export interface FinanceReconciliationResponse {
  period: { from: string; to: string };
  currency_code: string;
  currency_symbol?: string;
  currency_minor_unit?: number;
  region_id?: string | null;
  service_area_id?: string | null;
  is_mixed_currency_scope?: boolean;
  currency_groups?: Array<{
    currency_code: string;
    currency_symbol: string;
    currency_minor_unit: number;
    customer_revenue_pence: number;
    driver_net_pence: number;
    commission_pence: number;
    trip_count: number;
  }>;
  finance_reconciliation_summary?: FinanceReconciliationSummary;
  platform_kpis?: PlatformReconciliationKpis | null;
  trip_financial_audit?: TripFinancialAuditRow[];
  driver_statement_totals?: DriverStatementPeriodTotal[];
  stripe_payment_intents?: StripePaymentIntentAuditRow[];
  legacy_manual_review_items?: LegacyManualReviewItem[];
  money_movement?: ConnectMoneyMovementBundle;
  service_area_payment_gateways?: Array<{
    service_area_id: string;
    service_area_name: string | null;
    region_name: string | null;
    currency_code: string | null;
    customer: {
      status: string;
      badge_label: string;
      badge_emoji: string;
      display_name: string | null;
      provider: string | null;
      configuration_error: string | null;
      health?: {
        last_webhook_at?: string | null;
        last_connection_test_at?: string | null;
        webhook_healthy?: boolean | null;
      };
    };
    driver: {
      status: string;
      badge_label: string;
      badge_emoji: string;
      display_name: string | null;
      provider: string | null;
      configuration_error: string | null;
      health?: {
        last_webhook_at?: string | null;
        last_connection_test_at?: string | null;
        webhook_healthy?: boolean | null;
      };
    };
    last_successful_payment_at: string | null;
    last_successful_payout_at: string | null;
  }>;
  meta: {
    trip_count?: number;
    audit_row_count?: number;
    driver_count?: number;
    stripe_balance_error?: string | null;
    ssot_version?: string;
    data_source_badge?: string;
    accounting_rules?: Record<string, string>;
  };
}

/** Map SSOT reconciliation payload to legacy settlement overview shape (embedded widgets). */
export function toSettlementOverviewResponse(data: FinanceReconciliationResponse): FinanceSettlementSummaryResponse {
  const s = data.finance_reconciliation_summary;
  if (!s) {
    throw new Error('Finance reconciliation summary unavailable');
  }
  const check = s.reconciliation_check;
  return {
    currency_code: data.currency_code,
    customer_revenue_summary: {
      total_customer_revenue_pence: s.customer_revenue.total_customer_revenue_pence,
      total_commissionable_revenue_pence: s.customer_revenue.commissionable_revenue_pence,
      trip_count: data.meta.trip_count ?? 0,
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
      error: data.meta.stripe_balance_error,
      note: 'Platform balance — NOT ONECAB commission',
    },
    driver_payout_summary: {
      wallet_balance_pence: s.driver_money.driver_wallet_balance_pence,
      available_payout_pence: s.driver_money.driver_available_payout_pence,
      pending_payout_pence: s.driver_money.driver_pending_payout_pence,
      paid_out_pence: s.driver_money.driver_paid_out_pence,
      failed_amount_today_pence: 0,
      failure_reasons: [],
      safe_payout_amount_pence: s.driver_money.driver_available_payout_pence,
      waiting_for_stripe_funds:
        s.provider_money.provider_available_balance_pence < s.driver_money.driver_available_payout_pence,
    },
    reconciliation: {
      stripe_available_balance_pence: s.provider_money.provider_available_balance_pence,
      calculated_onecab_net_pence: s.onecab_money.onecab_card_net_commission_pence,
      available_driver_payable_pence: s.driver_money.driver_payout_liability_pence,
      pending_transfers_pence: s.driver_money.in_flight_cashout_pence,
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
    refetchInterval: () => {
      if (tripSearch) return false;
      if (typeof document !== 'undefined' && document.hidden) return false;
      return 120_000;
    },
    refetchIntervalInBackground: false,
    retry: 1,
    meta: { suppressErrorToast: true },
  });
}
