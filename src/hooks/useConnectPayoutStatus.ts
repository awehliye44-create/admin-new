// Stub — Provider payout status retired in Phase 3.
// TODO(Phase 3 UI purge): remove call sites and delete this file.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

export type ConnectPayoutStatus = {
  enabled: boolean;
  provider: "revolut" | null;
  message: string;
  connect_accounts: Array<{
    driver_id: string;
    stripe_account_id: string | null;
    charges_enabled: boolean;
    payouts_enabled: boolean;
    balance_pence: number;
    details_submitted: boolean;
    connect_account_status: string;
  }>;
};

const REMOVED: ConnectPayoutStatus = {
  enabled: false,
  provider: null,
  message: "Provider payouts retired — pending Revolut Business /pay integration.",
  connect_accounts: [],
};

export function useConnectPayoutStatus(_regionId?: string | null): UseQueryResult<ConnectPayoutStatus> {
  return useQuery({
    queryKey: ["connect-payout-status-removed"],
    queryFn: async () => REMOVED,
    staleTime: Infinity,
  });
}
