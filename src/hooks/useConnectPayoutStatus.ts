import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type ConnectInFlightPayout = {
  payout_id: string;
  amount_pence: number;
  status: string;
  automatic: boolean;
  arrival_date: string | null;
  in_ledger: boolean;
  in_payout_items: boolean;
  orphan_risk: boolean;
};

export type OnecabWalletSsot = {
  driver_earned_owed_pence: number;
  ledger_balance_pence: number;
  trip_earnings_pence: number;
  debt_recovery_pence: number;
  adjustments_pence: number;
  paid_out_pence: number;
};

export type StripeConnectSsot = {
  stripe_account_id: string;
  account_type: string | null;
  payouts_enabled: boolean;
  available_to_payout_pence: number;
  instant_available_pence: number;
  pending_pence: number;
  in_transit_pence: number;
  last_payout_id: string | null;
  last_payout_amount_pence: number | null;
  last_payout_date: string | null;
  last_payout_status: string | null;
  next_payout_date: string | null;
};

export type PlatformReconciliationSsot = {
  platform_available_pence: number;
  platform_pending_pence: number;
  platform_allocated_to_driver_pence: number;
  application_fees_pence: number;
  transfers_to_connect_count: number;
  transfers_to_connect_pence: number;
  reconciliation_status: string;
  reconciliation_variance_pence: number;
  source_tier: string;
  provider_settlement_evidence: string;
};

export type CashoutDecisionSsot = {
  wallet_owed_pence: number;
  finance_cleared_pence: number;
  connect_available_pence: number;
  cashout_now_pence: number;
  awaiting_settlement_pence: number;
  block_reasons: string[];
  cashout_enabled: boolean;
};

export type ConnectBalanceAccount = {
  driver_id: string;
  driver_code: string | null;
  driver_name: string;
  stripe_account_id: string;
  connect_account_status: string;
  connect_account_type?: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted?: boolean | null;
  db_payouts_enabled: boolean | null;
  requirements_due: string[];
  currency: string;
  onecab_wallet?: OnecabWalletSsot;
  stripe_connect?: StripeConnectSsot;
  platform_reconciliation?: PlatformReconciliationSsot;
  cashout_decision?: CashoutDecisionSsot;
  connect_available_pence: number;
  connect_instant_available_pence?: number;
  connect_pending_pence: number;
  connect_in_transit_pence?: number;
  connect_standard_available_pence?: number;
  weekly_instant_eligible_pence?: number;
  manual_instant_eligible_pence?: number;
  last_stripe_sync_at?: string | null;
  last_instant_payout_id?: string | null;
  last_instant_payout_date?: string | null;
  last_instant_payout_amount_pence?: number | null;
  payout_eligibility?: {
    weekly_instant_eligible_pence: number;
    manual_instant_eligible_pence: number;
    stripe_method: string;
  };
  wallet_balance_pence: number;
  wallet_owed_pence?: number;
  onecab_available_now_pence: number;
  finance_cleared_pence?: number;
  awaiting_settlement_pence: number;
  cashout_now_pence: number;
  cashout_block_reasons?: string[];
  cashout_enabled?: boolean;
  wallet_connect_difference_pence: number;
  max_manual_connect_payout_pence: number;
  manual_connect_payout_allowed: boolean;
  manual_connect_payout_block_reasons: string[];
  payout_blocked: boolean;
  payout_blocked_reasons?: string[];
  reconciliation_status?: string;
  next_payout_date?: string | null;
  last_stripe_transfer_id: string | null;
  last_transfer_amount_pence: number | null;
  last_transfer_date: string | null;
  last_payout_id: string | null;
  last_payout_status: string | null;
  last_payout_amount_pence: number | null;
  last_payout_date: string | null;
  payout_mode: 'manual' | 'automatic';
  payout_schedule_interval: string | null;
  payout_schedule_delay_days: number | null;
  automatic_payouts_enabled: boolean;
  in_flight_payouts: ConnectInFlightPayout[];
};

export type ConnectPayoutStatusResponse = {
  connect_accounts: ConnectBalanceAccount[];
  platform_stripe?: {
    available_pence: number;
    pending_pence: number;
  };
  ssot_note?: Record<string, string>;
  timestamp?: string;
  summary: {
    total: number;
    automatic_count: number;
    manual_count: number;
    in_flight_count: number;
    total_connect_available_pence?: number;
  };
};

export function useConnectPayoutStatus(regionId?: string | null) {
  return useQuery({
    queryKey: ['connect-payout-status', regionId ?? 'all'],
    queryFn: async (): Promise<ConnectPayoutStatusResponse> => {
      const { data, error } = await supabase.functions.invoke('admin-connect-payout-status', {
        body: regionId ? { region_id: regionId } : {},
      });
      if (error) throw error;
      return data as ConnectPayoutStatusResponse;
    },
    staleTime: 30_000,
  });
}

export async function invokeConnectPayoutLockdown(args: {
  dry_run?: boolean;
  confirm_lockdown?: boolean;
  region_id?: string;
}) {
  const { data, error } = await supabase.functions.invoke('admin-connect-payout-lockdown', {
    body: args,
  });
  if (error) throw error;
  return data;
}

export async function invokeConnectManualPayout(args: {
  driver_id: string;
  amount_pence: number;
  reason: string;
  verification_mode?: boolean;
}) {
  const { data, error } = await supabase.functions.invoke('admin-driver-connect-payout', {
    body: args,
  });
  if (error) throw error;
  return data as {
    success?: boolean;
    error?: string;
    error_code?: string;
    block_reasons?: string[];
    max_manual_payout_pence?: number;
    stripe_payout_id?: string;
    payout_item_id?: string;
  };
}
