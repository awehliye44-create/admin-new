import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type {
  AdminPayoutLedgerListRequest,
  AdminPayoutLedgerListResponse,
} from '../../shared/adminPayoutLedgerSSOT';
import { ADMIN_PAYOUT_LEDGER_FN } from '../../shared/adminPayoutLedgerSSOT';
import { isAdminPageLiveActive } from '@/lib/adminPageVisibility';

export function useAdminPayoutLedger(
  request: AdminPayoutLedgerListRequest,
  enabled = true,
) {
  const tab = request.tab ?? 'overview';
  return useQuery({
    queryKey: ['admin-payout-ledger', request],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke<AdminPayoutLedgerListResponse>(
        ADMIN_PAYOUT_LEDGER_FN,
        { body: request },
      );
      if (error) throw error;
      if (!data?.success) {
        throw new Error(data?.error ?? 'Payout ledger list failed');
      }
      return data;
    },
    enabled,
    staleTime: 60_000,
    refetchInterval: (query) => {
      if (!isAdminPageLiveActive()) return false;
      if (tab !== 'processing') return false;
      const processing = query.state.data?.summary?.processing_count ?? 0;
      return processing > 0 ? 90_000 : false;
    },
  });
}
