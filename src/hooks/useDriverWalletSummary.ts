import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type DriverWalletSummaryDto = {
  period: {
    key: string;
    from: string;
    to: string;
    timezone: string;
  };
  account: {
    live_balance_pence: number;
    available_balance_pence: number;
    pending_balance_pence: number;
    outstanding_debt_pence: number;
    annual_driver_earnings_pence: number;
  };
  summary: {
    driver_net_earnings_pence: number;
    trip_credit_pence: number;
    paid_trip_count: number;
    platform_commission_pence: number;
    bonus_pence: number;
    wallet_adjustment_pence: number;
    debt_recovered_pence: number;
    refund_chargeback_debit_pence: number;
    payout_debit_pence: number;
    net_wallet_movement_pence: number;
  };
};

/** Backend wallet-summary SSOT — no React money math. */
export function useDriverWalletSummary(args: {
  driverId: string | null;
  serviceAreaId?: string | null;
  period: string;
  from: string;
  to: string;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: [
      'driver-wallet-summary',
      args.driverId,
      args.serviceAreaId ?? null,
      args.period,
      args.from,
      args.to,
    ],
    enabled: Boolean(args.driverId && args.from && args.to && (args.enabled !== false)),
    queryFn: async (): Promise<DriverWalletSummaryDto> => {
      const { data, error } = await supabase.functions.invoke('admin-driver-wallet-ssot', {
        body: {
          mode: 'wallet_summary',
          driver_id: args.driverId,
          service_area_id: args.serviceAreaId ?? undefined,
          period: args.period,
          from: args.from,
          to: args.to,
        },
      });
      if (error) throw error;
      if (!data?.success || !data?.wallet_summary) {
        throw new Error(data?.error ?? 'Wallet summary fetch failed');
      }
      return data.wallet_summary as DriverWalletSummaryDto;
    },
    staleTime: 15_000,
  });
}
