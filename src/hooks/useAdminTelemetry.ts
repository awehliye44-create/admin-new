import { useEffect, useRef, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

const TELEMETRY_ENDPOINT = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ingest-telemetry`;
const API_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

type TelemetryEvent = {
  app_name: 'admin_panel';
  screen_name: string;
  metric_name: string;
  metric_value: number;
  unit?: string;
  platform?: string;
  session_id?: string;
  metadata?: Record<string, unknown>;
};

const sessionId = `admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const buffer: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function enqueue(event: TelemetryEvent) {
  buffer.push(event);
  if (buffer.length >= 10) {
    flush();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flush, 5000);
  }
}

async function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, buffer.length);
  try {
    await fetch(TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': API_KEY },
      body: JSON.stringify(batch),
    });
  } catch {
    // silently drop — telemetry is best-effort
  }
}

// Flush on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

/**
 * Track page/screen load time for the admin panel.
 * Call at the top of a page component — it measures time from mount to after first paint.
 */
export function usePageLoadTelemetry(screenName: string) {
  const mountTime = useRef(performance.now());

  useEffect(() => {
    // Measure after the browser has painted
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const loadTime = Math.round(performance.now() - mountTime.current);
        enqueue({
          app_name: 'admin_panel',
          screen_name: screenName,
          metric_name: 'screen_load_time',
          metric_value: loadTime,
          platform: 'web',
          session_id: sessionId,
        });
      });
    });
  }, [screenName]);
}

/**
 * Track API latency for a specific operation.
 * Returns a function: call start() before the API call, it returns a stop() to call after.
 */
export function useApiLatencyTracker(screenName: string) {
  return useCallback((operationName?: string) => {
    const start = performance.now();
    return {
      stop: () => {
        const duration = Math.round(performance.now() - start);
        enqueue({
          app_name: 'admin_panel',
          screen_name: screenName,
          metric_name: 'api_latency',
          metric_value: duration,
          platform: 'web',
          session_id: sessionId,
          metadata: operationName ? { operation: operationName } : undefined,
        });
      },
    };
  }, [screenName]);
}

/**
 * Track a user interaction delay (e.g., acknowledge/resolve button click to completion).
 */
export function trackInteraction(screenName: string, action: string, durationMs: number) {
  enqueue({
    app_name: 'admin_panel',
    screen_name: screenName,
    metric_name: 'interaction_delay',
    metric_value: durationMs,
    platform: 'web',
    session_id: sessionId,
    metadata: { action },
  });
}
