import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type DriverWalletPeriodKpis = {
  today_earnings_pence: number;
  week_earnings_pence: number;
  last_week_earnings_pence: number;
  month_earnings_pence: number;
  last_month_earnings_pence: number;
  quarter_earnings_pence?: number;
  year_earnings_pence: number;
  last_year_earnings_pence: number;
  lifetime_earnings_pence: number;
  pending_earnings_pence: number;
  total_bonuses_pence: number;
  total_adjustments_pence: number;
  outstanding_debt_pence: number;
  platform_commission_pence: number;
  provider_fees_reference_pence: number | null;
  trips_paid_count: number;
  average_earnings_per_trip_pence: number | null;
  timezone: 'Europe/London';
};

export type DriverWalletSettlementHistoryRow = {
  settlement_id: string;
  trip_id: string | null;
  trip_code: string | null;
  completed_at: string | null;
  customer_name: string | null;
  payment_provider: string | null;
  payment_method: string | null;
  customer_paid_pence: number | null;
  provider_fee_pence: number | null;
  platform_commission_pence: number | null;
  driver_commission_percent: number | null;
  driver_net_pence: number | null;
  wallet_credit_pence: number | null;
  settlement_status: string | null;
  payment_session_id: string | null;
};

export type DriverWalletSsotRow = {
  driver_id: string;
  user_id: string | null;
  driver_code: string | null;
  driver_name: string | null;
  connected_account_id: string | null;
  verification_status?: string | null;
  bank_account_last4?: string | null;
  payouts_enabled?: boolean | null;
  driver_tier_name?: string | null;
  commission_percent?: number | null;
  service_area_id?: string | null;
  service_area_name?: string | null;
  payout_provider?: string | null;
  next_scheduled_payout_at?: string | null;
  wallet_status?: 'ACTIVE' | 'FROZEN' | 'NOT_CONNECTED' | 'RESTRICTED' | string | null;
  current_onecab_wallet_owed_pence: number;
  finance_cleared_amount_pence: number;
  included_in_payout_batch_amount_pence: number;
  scheduled_payout_display_pence: number | null;
  stripe_connect_available_pence: number | null;
  stripe_connect_pending_pence: number | null;
  stripe_in_transit_pence: number | null;
  stripe_paid_out_total_pence: number;
  local_only_failed_payout_pence: number;
  failed_payout_stuck_processing_pence: number;
  recovery_debt_pence: number;
  cashout_limit_pence: number;
  reconciliation_status: string;
  reconciliation_reasons: string[];
  wallet_balance_pence: number;
  payout_blocked?: boolean;
  last_payout_at: string | null;
  last_payout_amount_pence: number | null;
  last_synced_at: string | null;
  period_kpis?: DriverWalletPeriodKpis;
  debt_recovery?: {
    outstanding_debt_pence: number;
    recovered_amount_pence: number;
    remaining_debt_pence: number;
    recovery_percent: number | null;
  };
  payout_items?: Array<Record<string, unknown>>;
  early_cashouts?: Array<Record<string, unknown>>;
  stripe_connect_payouts?: Array<Record<string, unknown>>;
  settlements?: Array<Record<string, unknown>>;
  settlement_history?: DriverWalletSettlementHistoryRow[];
  ledger_rows?: Array<Record<string, unknown>>;
  transfer_ledger_rows?: Array<Record<string, unknown>>;
};

export type DriverWalletSsotListResult = {
  drivers: DriverWalletSsotRow[];
  total: number;
  limit: number;
  offset: number;
};

const DEFAULT_PAGE_SIZE = 25;

export function useDriverWalletSsot(args?: {
  regionId?: string | null;
  page?: number;
  pageSize?: number;
}) {
  const page = Math.max(1, args?.page ?? 1);
  const pageSize = args?.pageSize ?? DEFAULT_PAGE_SIZE;
  const offset = (page - 1) * pageSize;
  const regionId = args?.regionId ?? null;

  return useQuery({
    queryKey: ['driver-wallet-ssot', regionId ?? 'all', page, pageSize],
    queryFn: async (): Promise<DriverWalletSsotListResult> => {
      const { data, error } = await supabase.functions.invoke('admin-driver-wallet-ssot', {
        body: {
          ...(regionId ? { region_id: regionId } : {}),
          limit: pageSize,
          offset,
        },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'SSOT fetch failed');
      return {
        drivers: (data.drivers ?? []) as DriverWalletSsotRow[],
        total: Number(data.total ?? 0),
        limit: Number(data.limit ?? pageSize),
        offset: Number(data.offset ?? offset),
      };
    },
    staleTime: 60_000,
  });
}

async function fetchAllDriverWalletSsotPages(regionId: string | null): Promise<DriverWalletSsotRow[]> {
  const pageSize = 50;
  let offset = 0;
  let total = Infinity;
  const all: DriverWalletSsotRow[] = [];

  while (offset < total) {
    const { data, error } = await supabase.functions.invoke('admin-driver-wallet-ssot', {
      body: {
        ...(regionId ? { region_id: regionId } : {}),
        limit: pageSize,
        offset,
      },
    });
    if (error) throw error;
    if (!data?.success) throw new Error(data?.error ?? 'SSOT fetch failed');

    const drivers = (data.drivers ?? []) as DriverWalletSsotRow[];
    total = Number(data.total ?? drivers.length);
    all.push(...drivers);
    offset += pageSize;
    if (drivers.length === 0) break;
  }

  return all;
}

/** Paginates through all driver-wallet SSOT rows for platform KPI aggregation. */
export function useDriverWalletSsotAll(regionId?: string | null) {
  return useQuery({
    queryKey: ['driver-wallet-ssot-all', regionId ?? 'all'],
    queryFn: () => fetchAllDriverWalletSsotPages(regionId ?? null),
    staleTime: 60_000,
  });
}

export function useDriverWalletSsotDetail(driverId: string | null) {
  return useQuery({
    queryKey: ['driver-wallet-ssot-detail', driverId],
    enabled: Boolean(driverId),
    queryFn: async (): Promise<DriverWalletSsotRow | null> => {
      if (!driverId) return null;
      const { data, error } = await supabase.functions.invoke('admin-driver-wallet-ssot', {
        body: { driver_id: driverId },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'SSOT fetch failed');
      return (data.driver ?? null) as DriverWalletSsotRow | null;
    },
    staleTime: 30_000,
  });
}
