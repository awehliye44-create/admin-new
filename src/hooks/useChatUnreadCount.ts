import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  isAdminDocumentVisible,
  isAdminTabLiveActive,
  subscribeAdminTabLiveActive,
} from '@/lib/adminTabLeader';

const REFETCH_DEBOUNCE_MS = 1_500;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let channelRef: ReturnType<typeof supabase.channel> | null = null;

/**
 * Lightweight hook that returns the total number of unread
 * support messages (sender_type != 'admin' && is_read = false).
 * Live listener only on the focused leader admin tab.
 */
export function useChatUnreadCount(): number {
  const [count, setCount] = useState(0);
  const [liveActive, setLiveActive] = useState(isAdminTabLiveActive);

  const fetchCount = useCallback(async () => {
    const { count: c } = await supabase
      .from('support_messages')
      .select('id', { count: 'exact', head: true })
      .eq('is_read', false)
      .neq('sender_type', 'admin');

    setCount(c ?? 0);
  }, []);

  const scheduleFetch = useCallback(() => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void fetchCount();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchCount]);

  useEffect(() => subscribeAdminTabLiveActive(setLiveActive), []);

  useEffect(() => {
    void fetchCount();
  }, [fetchCount]);

  useEffect(() => {
    const teardown = () => {
      if (channelRef) {
        supabase.removeChannel(channelRef);
        channelRef = null;
      }
    };

    if (!liveActive || !isAdminDocumentVisible()) {
      teardown();
      return teardown;
    }

    channelRef = supabase
      .channel('chat-unread-badge')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'support_messages' },
        scheduleFetch,
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'support_messages' },
        scheduleFetch,
      )

      .subscribe();

    return teardown;
  }, [liveActive, scheduleFetch]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && isAdminTabLiveActive()) {
        void fetchCount();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [fetchCount]);

  return count;
}
