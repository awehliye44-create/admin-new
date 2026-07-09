/**
 * P0 critical-button timeout — admin panel hook + telemetry.
 * Parent SSOT: shared/criticalButtonTimeoutSSOT.ts
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CRITICAL_BUTTON_MAX_SPINNER_MS,
  CRITICAL_BUTTON_TIMEOUT_LOG_EVENT,
  CRITICAL_BUTTON_TIMEOUT_MESSAGE,
  type CriticalButtonAction,
} from '../../shared/criticalButtonTimeoutSSOT';
import { recordAdminPerformanceStep } from '@/lib/recordAdminPerformanceStep';

export {
  CRITICAL_BUTTON_MAX_SPINNER_MS,
  CRITICAL_BUTTON_NORMAL_BACKEND_MS,
  CRITICAL_BUTTON_PAYMENT_DISPATCH_MS,
  CRITICAL_BUTTON_TIMEOUT_MESSAGE,
  CRITICAL_BUTTON_VISUAL_FEEDBACK_MS,
  type CriticalButtonAction,
} from '../../shared/criticalButtonTimeoutSSOT';

export type CriticalButtonTimeoutContext = {
  action: CriticalButtonAction;
  tripId?: string | null;
  paymentId?: string | null;
  clientActionId?: string | null;
  metadata?: Record<string, string | number | boolean | null | undefined>;
};

export function logCriticalButtonTimeout(
  input: CriticalButtonTimeoutContext & { durationMs: number },
): void {
  const payload = {
    event: CRITICAL_BUTTON_TIMEOUT_LOG_EVENT,
    action: input.action,
    duration_ms: Math.round(input.durationMs),
    trip_id: input.tripId ?? null,
    payment_id: input.paymentId ?? null,
    client_action_id: input.clientActionId ?? null,
    ...input.metadata,
  };
  console.warn(`[CriticalButton] ${CRITICAL_BUTTON_TIMEOUT_LOG_EVENT}`, payload);
  recordAdminPerformanceStep({
    action_name: 'critical_button_timeout',
    flow_type: 'ui_safety',
    duration_ms: Math.round(input.durationMs),
    success: false,
    error_code: input.action,
    metadata: payload,
  });
}

export function useCriticalButtonTimeout(input: {
  action: CriticalButtonAction;
  isPending: boolean;
  tripId?: string | null;
  paymentId?: string | null;
  clientActionId?: string | null;
  metadata?: Record<string, string | number | boolean | null | undefined>;
  maxSpinnerMs?: number;
  onTimeout?: () => void | Promise<void>;
}): {
  timedOut: boolean;
  resetTimeout: () => void;
  timeoutMessage: string;
  showSpinner: boolean;
} {
  const [timedOut, setTimedOut] = useState(false);
  const startedAtRef = useRef<number | null>(null);
  const onTimeoutRef = useRef(input.onTimeout);
  onTimeoutRef.current = input.onTimeout;
  const maxMs = input.maxSpinnerMs ?? CRITICAL_BUTTON_MAX_SPINNER_MS;

  const resetTimeout = useCallback(() => {
    setTimedOut(false);
    startedAtRef.current = null;
  }, []);

  useEffect(() => {
    if (!input.isPending) {
      if (!timedOut) startedAtRef.current = null;
      return;
    }
    if (timedOut) return;

    startedAtRef.current = performance.now();
    const timer = window.setTimeout(() => {
      const durationMs =
        startedAtRef.current != null
          ? performance.now() - startedAtRef.current
          : maxMs;
      logCriticalButtonTimeout({
        action: input.action,
        durationMs,
        tripId: input.tripId,
        paymentId: input.paymentId,
        clientActionId: input.clientActionId,
        metadata: input.metadata,
      });
      setTimedOut(true);
      void onTimeoutRef.current?.();
    }, maxMs);

    return () => window.clearTimeout(timer);
  }, [
    input.isPending,
    input.action,
    input.tripId,
    input.paymentId,
    input.clientActionId,
    input.metadata,
    maxMs,
    timedOut,
  ]);

  return {
    timedOut,
    resetTimeout,
    timeoutMessage: CRITICAL_BUTTON_TIMEOUT_MESSAGE,
    showSpinner: input.isPending && !timedOut,
  };
}
