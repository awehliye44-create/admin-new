/**
 * Admin Panel Telemetry Instance
 * ===============================
 * Singleton wrapper over the shared ONECAB Telemetry SDK.
 * All existing call-sites (usePageLoadTelemetry, useApiLatencyTracker, trackInteraction)
 * continue to work unchanged.
 */

import { OnecabTelemetry, useScreenLoad, useApiTimer } from '@/lib/telemetry';
import { useCallback } from 'react';

// ── Singleton ───────────────────────────────────────────────────────

export const adminTelemetry = new OnecabTelemetry({
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  appName: 'admin_panel',
  platform: 'web',
  appVersion: '1.0.0',
});

// Auto-flush on page hide
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') adminTelemetry.flush();
  });
}

// ── Backward-compatible hooks ───────────────────────────────────────

/** Track page/screen load time. Call at the top of a page component. */
export function usePageLoadTelemetry(screenName: string) {
  useScreenLoad(adminTelemetry, screenName);
}

/** Track API latency. Returns a timer factory. */
export function useApiLatencyTracker(screenName: string) {
  return useApiTimer(adminTelemetry, screenName);
}

/** Track a user interaction delay (fire-and-forget). */
export function trackInteraction(screenName: string, action: string, durationMs: number) {
  adminTelemetry.trackInteraction(screenName, durationMs, action);
}
