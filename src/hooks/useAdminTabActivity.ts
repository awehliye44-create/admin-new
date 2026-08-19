import { useEffect, useState } from 'react';
import { initAdminTabLeader, isAdminTabLiveActive, subscribeAdminTabLiveActive } from '@/lib/adminTabLeader';
import { useAuth } from '@/hooks/useAuth';
import { useAdminSupportPresence } from '@/hooks/useAdminSupportPresence';

/** Mount once at app root to coordinate single-tab live listeners. */
export function AdminTabActivityHost() {
  useEffect(() => initAdminTabLeader(), []);
  return null;
}

/** Mount once at app root to keep the admin support availability heartbeat alive. */
export function AdminSupportPresenceHost() {
  const { isAdmin, isAuthReady } = useAuth();
  useAdminSupportPresence(isAuthReady && isAdmin);
  return null;
}

export function useAdminTabLiveActive(): boolean {
  const [live, setLive] = useState(isAdminTabLiveActive);
  useEffect(() => subscribeAdminTabLiveActive(setLive), []);
  return live;
}
