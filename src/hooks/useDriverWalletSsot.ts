import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  mergeDriverWalletEligibilityOverlay,
  type DriverWalletEligibilityOverlay,
} from '@/lib/driverWalletSsotBalances';
import {
  ADMIN_FINANCE_QUERY_DEFAULTS,
  withAdminFinanceQueryTiming,
} from '@/lib/adminFinanceLoadPerf';

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
  expected_driver_credit_pence?: number | null;
  actual_driver_credit_pence?: number | null;
  credit_difference_pence?: number | null;
  driver_credit_health?: string | null;
  credit_eligibility_at?: string | null;
  is_diagnostic_projection?: boolean;
  diagnostic_label?: string | null;
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
  next_scheduled_payout_local?: string | null;
  schedule_label?: string | null;
  wallet_status?: 'ACTIVE' | 'FROZEN' | 'NOT_CONNECTED' | 'RESTRICTED' | string | null;
  current_onecab_wallet_owed_pence: number;
  finance_cleared_amount_pence: number;
  included_in_payout_batch_amount_pence: number;
  scheduled_payout_display_pence: number | null;
  provider_available_pence: number | null;
  provider_pending_pence: number | null;
  provider_in_transit_pence: number | null;
  provider_paid_out_total_pence: number;
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
  /** FR Drivers tab — backend SSOT fields (no client money math). */
  expected_payable_pence?: number | null;
  actual_wallet_trip_credits_pence?: number | null;
  wallet_adjustments_pence?: number | null;
  debt_recovery_pence?: number | null;
  payouts_debited_pence?: number | null;
  current_wallet_balance_pence?: number | null;
  available_for_payout_pence?: number | null;
  pending_balance_pence?: number | null;
  withdrawal_in_progress_pence?: number | null;
  provider_account_balance_pence?: number | null;
  provider_account_balance_status?: 'AVAILABLE' | 'UNAVAILABLE' | 'NOT_APPLICABLE' | string | null;
  wallet_variance_pence?: number | null;
  payout_variance_pence?: number | null;
  payout_ledger_completed_pence?: number | null;
  driver_credit_status?: string | null;
  payout_status?: string | null;
  query_scope_status?: string | null;
  verified_expected_payable_pence?: number | null;
  verified_wallet_credits_pence?: number | null;
  unverified_wallet_credits_pence?: number | null;
  missing_stamp_trip_count?: number | null;
  missing_stamp_trip_codes?: string[] | null;
  provider_balance_is_reference_only?: boolean;
  provider_connect_audit_status?: string | null;
  period_kpis?: DriverWalletPeriodKpis;
  debt_recovery?: {
    outstanding_debt_pence: number;
    recovered_amount_pence: number;
    remaining_debt_pence: number;
    recovery_percent: number | null;
  };
  payout_items?: Array<Record<string, unknown>>;
  early_cashouts?: Array<Record<string, unknown>>;
  provider_connect_payouts?: Array<Record<string, unknown>>;
  settlements?: Array<Record<string, unknown>>;
  settlement_history?: DriverWalletSettlementHistoryRow[];
  commission_fee_breakdown?: Array<{
    trip_id: string;
    trip_code: string | null;
    completed_at: string | null;
    payment_provider: string | null;
    payment_method: string | null;
    commissionable_fare_pence: number | null;
    commission_rate_percent: number | null;
    gross_onecab_commission_pence: number;
    provider_percentage_fee_pence: number | null;
    provider_fixed_fee_pence: number | null;
    total_provider_fee_pence: number;
    net_onecab_commission_pence: number;
    provider_transaction_id: string | null;
    fee_configuration_version: string | null;
    provider_fee_status: string;
    provider_fee_source: string | null;
    payment_session_id: string | null;
    running_net_onecab_balance_pence?: number;
  }>;
  commission_fee_summary?: {
    gross_onecab_commission_pence: number;
    payment_provider_fees_pence: number;
    net_onecab_commission_pence: number;
    transaction_count: number;
  };
  active_provider_fee_config?: Record<string, unknown> | null;
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

async function overlayDriverWalletEligibility(
  drivers: DriverWalletSsotRow[],
): Promise<DriverWalletSsotRow[]> {
  const ids = drivers.map((d) => d.driver_id).filter(Boolean);
  if (ids.length === 0) return drivers;

  let rows: DriverWalletEligibilityOverlay[] = [];
  const batch = await supabase.rpc(
    'admin_driver_wallet_eligibility_balances' as never,
    { p_driver_ids: ids } as never,
  );
  const batchRows = batch.data as unknown[] | null;
  if (!batch.error && Array.isArray(batchRows) && batchRows.length > 0) {
    rows = batchRows as DriverWalletEligibilityOverlay[];
  } else {
    const perDriver = await Promise.all(ids.map(async (id) => {
      const { data, error } = await supabase.rpc(
        'driver_wallet_eligibility_balances' as never,
        { p_driver_id: id } as never,
      );
      const singleRows = data as unknown[] | null;
      if (error || !Array.isArray(singleRows) || !singleRows[0]) return null;
      return { driver_id: id, ...(singleRows[0] as object) } as DriverWalletEligibilityOverlay;
    }));
    rows = perDriver.filter((row): row is DriverWalletEligibilityOverlay => Boolean(row));
  }

  const byId = new Map<string, DriverWalletEligibilityOverlay>();
  for (const row of rows) {
    if (row?.driver_id) byId.set(String(row.driver_id), row);
  }

  return drivers.map((row) => mergeDriverWalletEligibilityOverlay(row, byId.get(row.driver_id)));
}

export function useDriverWalletSsot(args?: {
  regionId?: string | null;
  serviceAreaId?: string | null;
  page?: number;
  pageSize?: number;
  periodFrom?: string | null;
  periodTo?: string | null;
}) {
  const page = Math.max(1, args?.page ?? 1);
  const pageSize = args?.pageSize ?? DEFAULT_PAGE_SIZE;
  const offset = (page - 1) * pageSize;
  const regionId = args?.regionId ?? null;
  const serviceAreaId = args?.serviceAreaId ?? null;
  const periodFrom = args?.periodFrom ?? null;
  const periodTo = args?.periodTo ?? null;

  return useQuery({
    queryKey: ['driver-wallet-ssot', regionId ?? 'all', serviceAreaId ?? 'all', periodFrom ?? 'all', periodTo ?? 'all', page, pageSize],
    queryFn: () =>
      withAdminFinanceQueryTiming(
        {
          page: 'driver_wallet_ledger',
          tab: 'drivers',
          query_name: 'fleet_page',
          rowCount: (r) => r.drivers?.length ?? 0,
        },
        async (): Promise<DriverWalletSsotListResult> => {
          const { data, error } = await supabase.functions.invoke('admin-driver-wallet-ssot', {
            body: {
              ...(regionId ? { region_id: regionId } : {}),
              ...(serviceAreaId ? { service_area_id: serviceAreaId } : {}),
              ...(periodFrom ? { from: periodFrom } : {}),
              ...(periodTo ? { to: periodTo } : {}),
              limit: pageSize,
              offset,
            },
          });
          if (error) throw error;
          if (!data?.success) throw new Error(data?.error ?? 'SSOT fetch failed');
          const drivers = await overlayDriverWalletEligibility(
            (data.drivers ?? []) as DriverWalletSsotRow[],
          );
          return {
            drivers,
            total: Number(data.total ?? 0),
            limit: Number(data.limit ?? pageSize),
            offset: Number(data.offset ?? offset),
          };
        },
      ),
    ...ADMIN_FINANCE_QUERY_DEFAULTS,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

async function fetchAllDriverWalletSsotPages(regionId: string | null): Promise<DriverWalletSsotRow[]> {
  const pageSize = 50;
  const { data: firstData, error: firstError } = await supabase.functions.invoke('admin-driver-wallet-ssot', {
    body: {
      ...(regionId ? { region_id: regionId } : {}),
      limit: pageSize,
      offset: 0,
    },
  });
  if (firstError) throw firstError;
  if (!firstData?.success) throw new Error(firstData?.error ?? 'SSOT fetch failed');

  const firstDrivers = await overlayDriverWalletEligibility(
    (firstData.drivers ?? []) as DriverWalletSsotRow[],
  );
  const total = Number(firstData.total ?? firstDrivers.length);
  if (total <= pageSize || firstDrivers.length === 0) return firstDrivers;

  const pageOffsets: number[] = [];
  for (let offset = pageSize; offset < total; offset += pageSize) {
    pageOffsets.push(offset);
  }

  const restPages = await Promise.all(
    pageOffsets.map(async (offset) => {
      const { data, error } = await supabase.functions.invoke('admin-driver-wallet-ssot', {
        body: {
          ...(regionId ? { region_id: regionId } : {}),
          limit: pageSize,
          offset,
        },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'SSOT fetch failed');
      return overlayDriverWalletEligibility((data.drivers ?? []) as DriverWalletSsotRow[]);
    }),
  );

  return [...firstDrivers, ...restPages.flat()];
}

/** Paginates through all driver-wallet SSOT rows for platform KPI aggregation. */
export function useDriverWalletSsotAll(regionId?: string | null) {
  return useQuery({
    queryKey: ['driver-wallet-ssot-all', regionId ?? 'all'],
    queryFn: () =>
      withAdminFinanceQueryTiming(
        {
          page: 'driver_wallet_ledger',
          tab: 'fleet_overview',
          query_name: 'fleet_all_pages',
          rowCount: (r) => r.length,
        },
        () => fetchAllDriverWalletSsotPages(regionId ?? null),
      ),
    ...ADMIN_FINANCE_QUERY_DEFAULTS,
    staleTime: 60_000,
  });
}

export function useDriverWalletSsotDetail(driverId: string | null) {
  return useQuery({
    queryKey: ['driver-wallet-ssot-detail', driverId],
    enabled: Boolean(driverId),
    queryFn: () =>
      withAdminFinanceQueryTiming(
        {
          page: 'driver_wallet_ledger',
          tab: 'driver_detail',
          query_name: 'driver_detail',
          rowCount: (r) => (r ? 1 : 0),
        },
        async (): Promise<DriverWalletSsotRow | null> => {
          if (!driverId) return null;
          const { data, error } = await supabase.functions.invoke('admin-driver-wallet-ssot', {
            body: { driver_id: driverId },
          });
          if (error) throw error;
          if (!data?.success) throw new Error(data?.error ?? 'SSOT fetch failed');
          const driver = (data.driver ?? null) as DriverWalletSsotRow | null;
          if (!driver) return null;
          const [overlaid] = await overlayDriverWalletEligibility([driver]);
          return overlaid ?? driver;
        },
      ),
    ...ADMIN_FINANCE_QUERY_DEFAULTS,
    staleTime: 45_000,
    placeholderData: keepPreviousData,
  });
}
