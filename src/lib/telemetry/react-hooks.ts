/**
 * React hooks for ONECAB Telemetry
 * =================================
 * Works with React 18+ (web) and React Native.
 * Import the TelemetryClient and these hooks into any React-based surface.
 */

import { useEffect, useRef, useCallback } from 'react';
import { TelemetryClient, MetricName } from './telemetryClient';

/**
 * Track screen/page load time.
 * Measures mount → first paint (web) or mount → effect (React Native).
 */
export function useScreenLoadTelemetry(client: TelemetryClient, screenName: string) {
  const mountTime = useRef(
    typeof performance !== 'undefined' ? performance.now() : Date.now()
  );

  useEffect(() => {
    mountTime.current = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // Web: wait for paint. React Native: measure immediately.
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
          const loadTime = Math.round(now - mountTime.current);
          client.track(screenName, 'screen_load_time', loadTime);
        });
      });
    } else {
      // React Native path
      const now = Date.now();
      const loadTime = Math.round(now - mountTime.current);
      client.track(screenName, 'screen_load_time', loadTime);
    }
  }, [screenName, client]);
}

/**
 * Returns a timer factory for tracking API latency.
 * Usage: const track = useApiTimer(client, 'HomeScreen');
 *        const timer = track('fetchTrips');
 *        await api.fetchTrips();
 *        timer.stop();
 */
export function useApiTimer(client: TelemetryClient, screenName: string) {
  return useCallback(
    (operationName?: string) => {
      return client.startTimer(screenName, 'api_latency', operationName ? { operation: operationName } : undefined);
    },
    [client, screenName]
  );
}

/**
 * Track a user interaction delay (button press to completion).
 */
export function useInteractionTracker(client: TelemetryClient, screenName: string) {
  return useCallback(
    (action: string) => {
      return client.startTimer(screenName, 'interaction_delay', { action });
    },
    [client, screenName]
  );
}

/**
 * Auto-flush telemetry on page hide (web) or app background (React Native via AppState).
 * Call once at app root.
 */
export function useTelemetryFlushOnHide(client: TelemetryClient) {
  useEffect(() => {
    if (typeof document !== 'undefined') {
      const handler = () => {
        if (document.visibilityState === 'hidden') client.flush();
      };
      document.addEventListener('visibilitychange', handler);
      return () => document.removeEventListener('visibilitychange', handler);
    }
    // React Native: teams should call client.flush() in AppState 'background' handler
  }, [client]);
}
