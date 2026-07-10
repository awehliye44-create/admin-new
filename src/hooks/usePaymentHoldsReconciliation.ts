import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type {
  AdminHoldActionRequest,
  AdminPaymentHoldsReconciliationResponse,
} from '../../shared/paymentHoldReconciliation';
import {
  ADMIN_HOLD_ACTION_FN,
  ADMIN_PAYMENT_HOLDS_RECONCILIATION_FN,
} from '../../shared/paymentHoldReconciliation';

export function usePaymentHoldsReconciliation(enabled = true) {
  return useQuery({
    queryKey: ['payment-holds-reconciliation'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke<AdminPaymentHoldsReconciliationResponse>(
        ADMIN_PAYMENT_HOLDS_RECONCILIATION_FN,
        { body: { refresh_provider_state: true } },
      );
      if (error) throw error;
      if (!data?.success) {
        throw new Error(data?.error ?? 'Payment holds reconciliation failed');
      }
      return data;
    },
    enabled,
    staleTime: 60_000,
    refetchInterval: (query) => {
      if (typeof document !== 'undefined' && document.hidden) return false;
      const red = query.state.data?.summary?.red ?? 0;
      const amber = query.state.data?.summary?.amber ?? 0;
      return red > 0 ? 60_000 : amber > 0 ? 120_000 : false;
    },
  });
}

export function useAdminHoldAction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: AdminHoldActionRequest) => {
      const { data, error } = await supabase.functions.invoke(ADMIN_HOLD_ACTION_FN, { body });
      if (error) throw error;
      if (data && typeof data === 'object' && 'success' in data && data.success === false) {
        throw new Error(
          typeof (data as { error?: unknown }).error === 'string'
            ? (data as { error: string }).error
            : 'Hold action failed',
        );
      }
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['payment-holds-reconciliation'] });
    },
  });
}
