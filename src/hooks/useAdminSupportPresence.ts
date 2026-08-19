/**
 * useAdminSupportPresence
 *
 * Sends a heartbeat to admin-support-heartbeat every 30 seconds while an
 * authorised admin is signed in and this tab is the active leader tab.
 *
 * Stops immediately on sign-out. The website polls admin-support-status
 * (max-age=30s) to decide whether to show the customer support widget.
 */

import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { isAdminTabLiveActive, subscribeAdminTabLiveActive } from "@/lib/adminTabLeader";

const HEARTBEAT_INTERVAL_MS = 30_000;
const SUPABASE_URL = "https://thazislrdkjpvvghtvzo.supabase.co";

async function sendHeartbeat(accessToken: string): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/admin-support-heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": (supabase as unknown as { supabaseKey?: string }).supabaseKey ?? "",
        "Authorization": `Bearer ${accessToken}`,
      },
    });
  } catch {
    // Heartbeat failures are non-fatal — the widget stays hidden after 2 min stale.
  }
}

export function useAdminSupportPresence(isAuthenticated: boolean): void {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveActiveRef = useRef(isAdminTabLiveActive());

  useEffect(() => {
    // Track tab-leader state via subscription.
    const unsub = subscribeAdminTabLiveActive((active) => {
      liveActiveRef.current = active;
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    async function beat() {
      // Only the leader tab sends the heartbeat.
      if (!liveActiveRef.current) return;
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;
      await sendHeartbeat(session.access_token);
    }

    // Fire immediately on sign-in, then every 30s.
    void beat();
    timerRef.current = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isAuthenticated]);
}
