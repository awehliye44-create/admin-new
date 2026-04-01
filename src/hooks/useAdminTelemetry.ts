/**
 * Admin Panel Telemetry — uses the shared ONECAB Telemetry Client.
 * This is the admin-specific wrapper; other apps use their own singleton.
 */

import { useEffect, useRef, useCallback } from 'react';
import { TelemetryClient } from '@/lib/telemetry';
import { useScreenLoadTelemetry, useApiTimer } from '@/lib/telemetry';

// Singleton client for the admin panel
const adminTelemetry = new TelemetryClient({
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  appName: 'admin_panel',
  platform: 'web',
});

// Auto-flush on page hide
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') adminTelemetry.flush();
  });
}

/**
 * Track page/screen load time for the admin panel.
 * Call at the top of a page component.
 */
export function usePageLoadTelemetry(screenName: string) {
  useScreenLoadTelemetry(adminTelemetry, screenName);
}

/**
 * Track API latency for a specific operation.
 * Returns a function: call start() before the API call, it returns a stop() to call after.
 */
export function useApiLatencyTracker(screenName: string) {
  return useApiTimer(adminTelemetry, screenName);
}

/**
 * Track a user interaction delay (e.g., acknowledge/resolve button click to completion).
 */
export function trackInteraction(screenName: string, action: string, durationMs: number) {
  adminTelemetry.track(screenName, 'interaction_delay', durationMs, { action });
}

/** Expose the client for advanced use */
export { adminTelemetry };
