import { useEffect, useState, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { isAdminPageLiveActive, subscribeAdminPageLiveActive } from '@/lib/adminPageVisibility';

type RealtimeStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

/**
 * Central hook for Ops Intelligence realtime subscriptions.
 * Subscribes to ops_alerts changes and invalidates all relevant queries.
 * Shows critical/fatal alert toasts when new alerts arrive.
 */
export function useOpsRealtime() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const [lastEvent, setLastEvent] = useState<Date | null>(null);
  const toastShownRef = useRef<Set<string>>(new Set());

  const invalidateAll = useCallback(() => {
    // Only invalidate alerts and health — logs are user-initiated
    queryClient.invalidateQueries({ queryKey: ['ops-alerts'] });
    queryClient.invalidateQueries({ queryKey: ['ops-health-summary'] });
    setLastEvent(new Date());
  }, [queryClient]);

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const teardown = () => {
      if (channel) {
        supabase.removeChannel(channel);
        channel = null;
      }
      setStatus('disconnected');
    };

    const setup = () => {
      teardown();
      if (!isAdminPageLiveActive()) return;

      channel = supabase
        .channel('ops-realtime-v2')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'ops_alerts' },
          (payload) => {
            invalidateAll();
            const alert = payload.new as any;
            if (
              alert &&
              (alert.severity === 'critical' || alert.severity === 'fatal') &&
              alert.status === 'open' &&
              !toastShownRef.current.has(alert.id)
            ) {
              toastShownRef.current.add(alert.id);
              toast.error(`🚨 ${alert.severity.toUpperCase()}: ${alert.title}`, {
                description: alert.description || `Category: ${alert.category}`,
                duration: 10000,
                action: {
                  label: 'View',
                  onClick: () => {
                    window.dispatchEvent(new CustomEvent('ops-focus-alert', { detail: alert.id }));
                  },
                },
              });
            }
          },
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'ops_alerts' },
          () => {
            invalidateAll();
          },
        )
        .subscribe((state) => {
          if (state === 'SUBSCRIBED') setStatus('connected');
          else if (state === 'CLOSED') setStatus('disconnected');
          else if (state === 'CHANNEL_ERROR') setStatus('error');
          else setStatus('connecting');
        });
    };

    setup();
    const unsub = subscribeAdminPageLiveActive(setup);
    document.addEventListener('visibilitychange', setup);

    return () => {
      unsub();
      document.removeEventListener('visibilitychange', setup);
      teardown();
    };
  }, [invalidateAll]);

  return { status, lastEvent };
}
