import { useEffect, useState } from 'react';
import { initAdminTabLeader, isAdminTabLiveActive, subscribeAdminTabLiveActive } from '@/lib/adminTabLeader';

/** Mount once at app root to coordinate single-tab live listeners. */
export function AdminTabActivityHost() {
  useEffect(() => initAdminTabLeader(), []);
  return null;
}

export function useAdminTabLiveActive(): boolean {
  const [live, setLive] = useState(isAdminTabLiveActive);
  useEffect(() => subscribeAdminTabLiveActive(setLive), []);
  return live;
}
