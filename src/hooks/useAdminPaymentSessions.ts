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
      // Auto-retry when provider sync is pending — never overwrite verified values server-side.
      if (query.state.data?.provider_verification_message) return 45_000;
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
      // Prefer structured body error codes (PAYMENT_ACTION_STALE_REFRESH_REQUIRED, …).
      if (data && typeof data === 'object' && 'success' in data && (data as { success?: boolean }).success === false) {
        throw new Error(
          typeof (data as { error?: unknown }).error === 'string'
            ? (data as { error: string }).error
            : 'Hold action failed',
        );
      }
      if (error) throw error;
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
    mutationFn: async (args: {
      tripId: string;
      amountPence: number;
      reason?: string;
    }) => {
      const { data, error } = await supabase.functions.invoke('admin-refund-trip-payment', {
        body: {
          trip_id: args.tripId,
          amount_pence: args.amountPence,
          reason: args.reason
            ?? `Payment Sessions refund £${(args.amountPence / 100).toFixed(2)}`,
        },
      });
      // Prefer structured body (Lovable / FunctionsHttpError often wraps non-2xx).
      if (data && typeof data === 'object' && (data as { success?: boolean }).success === false) {
        throw new Error(
          typeof (data as { error?: unknown }).error === 'string'
            ? (data as { error: string }).error
            : 'Refund failed',
        );
      }
      if (data && typeof data === 'object' && (data as { error?: unknown }).error) {
        throw new Error(String((data as { error: unknown }).error));
      }
      if (error) {
        const ctx = (error as { context?: Response }).context;
        if (ctx && typeof ctx.json === 'function') {
          try {
            const body = await ctx.json() as { error?: string; message?: string };
            throw new Error(body.error || body.message || error.message);
          } catch (inner) {
            if (inner instanceof Error && inner.message !== error.message) throw inner;
          }
        }
        throw error;
      }
      return data as {
        success?: boolean;
        refunded_pence?: number;
        total_refunded_pence?: number;
        message?: string;
      };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-payment-sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['payment-holds-reconciliation'] });
    },
  });
}
