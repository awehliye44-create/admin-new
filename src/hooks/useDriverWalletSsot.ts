import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type DriverWalletSsotRow = {
  driver_id: string;
  user_id: string | null;
  driver_code: string | null;
  connected_account_id: string | null;
  current_onecab_wallet_owed_pence: number;
  finance_cleared_amount_pence: number;
  included_in_payout_batch_amount_pence: number;
  stripe_connect_available_pence: number | null;
  stripe_connect_pending_pence: number | null;
  stripe_in_transit_pence: number | null;
  stripe_paid_out_total_pence: number;
  recovery_debt_pence: number;
  cashout_limit_pence: number;
  reconciliation_status: string;
  reconciliation_reasons: string[];
  wallet_balance_pence: number;
  last_synced_at: string | null;
  payout_items?: Array<Record<string, unknown>>;
  stripe_connect_payouts?: Array<Record<string, unknown>>;
  settlements?: Array<Record<string, unknown>>;
};

export function useDriverWalletSsot(regionId?: string | null) {
  return useQuery({
    queryKey: ['driver-wallet-ssot', regionId ?? 'all'],
    queryFn: async (): Promise<DriverWalletSsotRow[]> => {
      const { data, error } = await supabase.functions.invoke('admin-driver-wallet-ssot', {
        body: regionId ? { region_id: regionId } : {},
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'SSOT fetch failed');
      return (data.drivers ?? []) as DriverWalletSsotRow[];
    },
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
