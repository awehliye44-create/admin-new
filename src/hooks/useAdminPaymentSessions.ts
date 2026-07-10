import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type {
  AdminPaymentSessionsListRequest,
  AdminPaymentSessionsListResponse,
} from '../../shared/adminPaymentSessionsSSOT';
import { ADMIN_PAYMENT_SESSIONS_FN } from '../../shared/adminPaymentSessionsSSOT';
import {
  ADMIN_HOLD_ACTION_FN,
  type AdminHoldActionRequest,
} from '../../shared/paymentHoldReconciliation';
import { isAdminPageLiveActive } from '@/lib/adminPageVisibility';

export function useAdminPaymentSessions(
  request: AdminPaymentSessionsListRequest,
  enabled = true,
) {
  const tab = request.tab ?? 'overview';
  return useQuery({
    queryKey: ['admin-payment-sessions', request],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke<AdminPaymentSessionsListResponse>(
        ADMIN_PAYMENT_SESSIONS_FN,
        {
          body: {
            ...request,
            refresh_provider_state:
              request.refresh_provider_state
              ?? (tab === 'active_holds' || tab === 'failed_recovery'),
          },
        },
      );
      if (error) throw error;
      if (!data?.success) {
        throw new Error(data?.error ?? 'Payment sessions list failed');
      }
      return data;
    },
    enabled,
    staleTime: 60_000,
    refetchInterval: (query) => {
      if (!isAdminPageLiveActive()) return false;
      if (tab !== 'active_holds' && tab !== 'failed_recovery') return false;
      const red = query.state.data?.summary?.red ?? 0;
      const unresolved = query.state.data?.summary?.active_hold_count ?? 0;
      if (unresolved <= 0) return false;
      return red > 0 ? 60_000 : 120_000;
    },
  });
}

export function usePaymentSessionHoldAction() {
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
      void queryClient.invalidateQueries({ queryKey: ['admin-payment-sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['payment-holds-reconciliation'] });
    },
  });
}

export function useInspectPaymentSessionProvider() {
  return useMutation({
    mutationFn: async (providerOrderId: string) => {
      const { data, error } = await supabase.functions.invoke(ADMIN_PAYMENT_SESSIONS_FN, {
        body: { inspect_provider_order_id: providerOrderId },
      });
      if (error) throw error;
      if (!data?.success) {
        throw new Error(data?.error ?? data?.provider_verification_message ?? 'Inspect failed');
      }
      return data.sanitised_provider_state as Record<string, unknown>;
    },
  });
}

export function usePaymentSessionRefund() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: { providerOrderId: string }) => {
      const { data, error } = await supabase.functions.invoke('admin-recover-revolut-orphan', {
        body: {
          provider_order_id: args.providerOrderId,
          action: 'refund',
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(String(data.error));
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-payment-sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['payment-holds-reconciliation'] });
    },
  });
}
