/**
 * Ensures only one admin browser tab runs live dispatch/support realtime listeners.
 * Hidden tabs pause all live activity; visible non-leader tabs stay passive.
 */

const CHANNEL_NAME = 'onecab-admin-tab-leader';
const LOCK_KEY = 'onecab-admin-tab-leader-lock';
const LOCK_STALE_MS = 15_000;

type LeaderListener = (isLeader: boolean) => void;

let tabId: string | null = null;
let isLeader = false;
let isVisible = typeof document === 'undefined' || document.visibilityState === 'visible';
const listeners = new Set<LeaderListener>();
let channel: BroadcastChannel | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function getTabId(): string {
  if (!tabId) {
    tabId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return tabId;
}

function readLock(): { tabId: string; at: number } | null {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { tabId?: string; at?: number };
    if (!parsed.tabId || typeof parsed.at !== 'number') return null;
    return { tabId: parsed.tabId, at: parsed.at };
  } catch {
    return null;
  }
}

function writeLock(id: string) {
  try {
    localStorage.setItem(LOCK_KEY, JSON.stringify({ tabId: id, at: Date.now() }));
  } catch {
    // ignore quota errors
  }
}

function notify() {
  const active = isVisible && isLeader;
  listeners.forEach((listener) => listener(active));
}

function claimLeadership(): boolean {
  const id = getTabId();
  const lock = readLock();
  const now = Date.now();
  if (!lock || now - lock.at > LOCK_STALE_MS || lock.tabId === id) {
    writeLock(id);
    isLeader = true;
    notify();
    return true;
  }
  isLeader = false;
  notify();
  return false;
}

function releaseLeadership() {
  const id = getTabId();
  const lock = readLock();
  if (lock?.tabId === id) {
    try {
      localStorage.removeItem(LOCK_KEY);
    } catch {
      // ignore
    }
  }
  isLeader = false;
  notify();
}

function ensureChannel() {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event) => {
    const type = event.data?.type;
    if (type === 'leader-heartbeat' || type === 'leader-claim') {
      const foreignId = event.data?.tabId as string | undefined;
      if (foreignId && foreignId !== getTabId()) {
        isLeader = false;
        notify();
      }
    }
    if (type === 'leader-release' && isVisible) {
      claimLeadership();
    }
  };
}

function broadcast(type: string) {
  channel?.postMessage({ type, tabId: getTabId() });
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (!isVisible) return;
    if (isLeader) {
      writeLock(getTabId());
      broadcast('leader-heartbeat');
    } else {
      claimLeadership();
    }
  }, LOCK_STALE_MS / 2);
}

function stopHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

let initialized = false;

export function initAdminTabLeader(): () => void {
  if (initialized || typeof window === 'undefined') return () => undefined;
  initialized = true;
  ensureChannel();

  const onVisibility = () => {
    isVisible = document.visibilityState === 'visible';
    if (isVisible) {
      claimLeadership();
      broadcast('leader-claim');
    } else {
      releaseLeadership();
      broadcast('leader-release');
    }
    notify();
  };

  const onFocus = () => {
    if (document.visibilityState === 'visible') {
      claimLeadership();
      broadcast('leader-claim');
    }
  };

  const onUnload = () => {
    releaseLeadership();
    broadcast('leader-release');
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  window.addEventListener('pagehide', onUnload);
  startHeartbeat();
  onVisibility();

  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('pagehide', onUnload);
    stopHeartbeat();
    releaseLeadership();
    channel?.close();
    channel = null;
    initialized = false;
  };
}

/** True when this tab is visible AND holds the live-listener leadership lock. */
export function isAdminTabLiveActive(): boolean {
  return isVisible && isLeader;
}

export function subscribeAdminTabLiveActive(listener: LeaderListener): () => void {
  listeners.add(listener);
  listener(isAdminTabLiveActive());
  return () => listeners.delete(listener);
}

export function isAdminDocumentVisible(): boolean {
  return isVisible;
}
