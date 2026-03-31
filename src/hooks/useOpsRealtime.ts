import { useEffect, useState, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

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
    queryClient.invalidateQueries({ queryKey: ['ops-alerts'] });
    queryClient.invalidateQueries({ queryKey: ['ops-health-summary'] });
    queryClient.invalidateQueries({ queryKey: ['ops-logs'] });
    setLastEvent(new Date());
  }, [queryClient]);

  useEffect(() => {
    const channel = supabase
      .channel('ops-realtime-v2')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'ops_alerts' },
        (payload) => {
          invalidateAll();
          // Show toast for critical/fatal new alerts
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
                  // Will be handled by the page component
                  window.dispatchEvent(new CustomEvent('ops-focus-alert', { detail: alert.id }));
                },
              },
            });
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'ops_alerts' },
        () => {
          invalidateAll();
        }
      )
      .subscribe((state) => {
        if (state === 'SUBSCRIBED') setStatus('connected');
        else if (state === 'CLOSED') setStatus('disconnected');
        else if (state === 'CHANNEL_ERROR') setStatus('error');
        else setStatus('connecting');
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [invalidateAll]);

  return { status, lastEvent };
}
