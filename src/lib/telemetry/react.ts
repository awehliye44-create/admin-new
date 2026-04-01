/**
 * ONECAB Telemetry — React Hooks Adapter
 * ========================================
 * Works with React 18+ on web and React Native.
 * Provides hooks that integrate with the OnecabTelemetry core.
 */

import { useEffect, useRef, useCallback } from 'react';
import type { OnecabTelemetry, MetricName } from './core';

// ── Screen Load ─────────────────────────────────────────────────────

/**
 * Measures time from component mount to first paint (web)
 * or mount-to-effect (React Native).
 *
 * Usage:
 *   useScreenLoad(telemetry, 'HomeScreen');
 */
export function useScreenLoad(client: OnecabTelemetry, screenName: string) {
  const mountRef = useRef(
    typeof performance !== 'undefined' ? performance.now() : Date.now(),
  );

  useEffect(() => {
    mountRef.current =
      typeof performance !== 'undefined' ? performance.now() : Date.now();

    const measure = () => {
      const elapsed =
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
        mountRef.current;
      client.trackScreenLoad(screenName, elapsed);
    };

    if (typeof requestAnimationFrame !== 'undefined') {
      // Web: wait two frames so the browser has actually painted
      requestAnimationFrame(() => requestAnimationFrame(measure));
    } else {
      // React Native: measure on effect
      measure();
    }
  }, [screenName, client]);
}

// ── API Timer Hook ──────────────────────────────────────────────────

/**
 * Returns a factory function that creates API latency timers.
 *
 * Usage:
 *   const api = useApiTimer(telemetry, 'Dashboard');
 *   const t = api('fetchTrips');
 *   await fetchTrips();
 *   t.stop();
 */
export function useApiTimer(client: OnecabTelemetry, screenName: string) {
  return useCallback(
    (operation?: string) => client.startApiTimer(screenName, operation),
    [client, screenName],
  );
}

// ── Flow Timer Hook ─────────────────────────────────────────────────

/**
 * Returns a factory function that creates flow-step timers.
 *
 * Usage:
 *   const flow = useFlowTimer(telemetry, 'BookingFlow');
 *   const t = flow('select_vehicle');
 *   // ...user selects vehicle...
 *   t.stop();
 */
export function useFlowTimer(client: OnecabTelemetry, screenName: string) {
  return useCallback(
    (step: string) => client.startFlowTimer(screenName, step),
    [client, screenName],
  );
}

// ── Interaction Timer Hook ──────────────────────────────────────────

/**
 * Returns a function that creates interaction-delay timers.
 */
export function useInteractionTimer(client: OnecabTelemetry, screenName: string) {
  return useCallback(
    (action: string) => client.startTimer(screenName, 'interaction_delay', { action }),
    [client, screenName],
  );
}

// ── Flush on Hide ───────────────────────────────────────────────────

/**
 * Auto-flush when page/app goes to background.
 * Call once at app root.
 *
 * For React Native, also call client.flush() in AppState 'background'.
 */
export function useFlushOnHide(client: OnecabTelemetry) {
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handler = () => {
      if (document.visibilityState === 'hidden') client.flush();
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [client]);
}

// ── Route Change Tracker (React Router) ─────────────────────────────

/**
 * Tracks screen_load_time whenever the route path changes.
 * Use with react-router-dom's useLocation().
 *
 * Usage (in App.tsx or layout):
 *   const location = useLocation();
 *   useRouteChangeTracker(telemetry, location.pathname);
 */
export function useRouteChangeTracker(
  client: OnecabTelemetry,
  pathname: string,
) {
  const navStart = useRef(
    typeof performance !== 'undefined' ? performance.now() : Date.now(),
  );
  const prevPath = useRef(pathname);

  useEffect(() => {
    if (pathname === prevPath.current) return;
    prevPath.current = pathname;
    navStart.current =
      typeof performance !== 'undefined' ? performance.now() : Date.now();

    const measure = () => {
      const elapsed =
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
        navStart.current;
      // Convert pathname to readable screen name: /ops-intelligence → OpsIntelligence
      const screen = pathname
        .replace(/^\//, '')
        .split('/')
        .map((s) => s.replace(/-./g, (m) => m[1].toUpperCase()))
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join('/') || 'Home';
      client.trackScreenLoad(screen, elapsed);
    };

    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => requestAnimationFrame(measure));
    } else {
      measure();
    }
  }, [pathname, client]);
}
