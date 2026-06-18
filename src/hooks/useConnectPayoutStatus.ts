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

export type ConnectPayoutAccount = {
  driver_id: string;
  driver_code: string | null;
  driver_name: string;
  stripe_account_id: string;
  db_payouts_enabled: boolean | null;
  payout_mode: 'manual' | 'automatic';
  payout_schedule_interval: string | null;
  payout_schedule_delay_days: number | null;
  automatic_payouts_enabled: boolean;
  connect_available_pence: number;
  connect_pending_pence: number;
  in_flight_payouts: ConnectInFlightPayout[];
  last_lockdown_audit: {
    action: string;
    after_interval: string | null;
    dry_run: boolean;
    created_at: string;
  } | null;
};

export type ConnectPayoutStatusResponse = {
  connect_accounts: ConnectPayoutAccount[];
  summary: {
    total: number;
    automatic_count: number;
    manual_count: number;
    in_flight_count: number;
  };
  recent_audits: Array<Record<string, unknown>>;
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
