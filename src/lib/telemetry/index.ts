/**
 * ONECAB Telemetry — Public API
 * ==============================
 * Central export point for the shared SDK.
 */

// Core client
export { OnecabTelemetry } from './core';
export type {
  OnecabTelemetryConfig,
  TelemetryEvent,
  AppName,
  MetricName,
  Platform,
} from './core';

// React hooks (web + React Native)
export {
  useScreenLoad,
  useApiTimer,
  useFlowTimer,
  useInteractionTimer,
  useFlushOnHide,
  useRouteChangeTracker,
} from './react';

// Fetch interceptor
export { installFetchInterceptor } from './fetchInterceptor';
