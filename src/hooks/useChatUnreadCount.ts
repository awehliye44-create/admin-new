import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * Lightweight hook that returns the total number of unread
 * support messages (sender_type != 'admin' && is_read = false).
 * Subscribes to realtime changes on support_messages.
 */
export function useChatUnreadCount(): number {
  const [count, setCount] = useState(0);

  const fetchCount = useCallback(async () => {
    const { count: c } = await supabase
      .from('support_messages')
      .select('id', { count: 'exact', head: true })
      .eq('is_read', false)
      .neq('sender_type', 'admin');

    setCount(c ?? 0);
  }, []);

  useEffect(() => {
    fetchCount();

    const channel = supabase
      .channel('chat-unread-badge')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'support_messages' },
        () => fetchCount()
      )

      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchCount]);

  return count;
}
