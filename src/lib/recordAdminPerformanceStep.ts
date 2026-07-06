/**
 * P0 performance health — Admin Panel action timings → ingest-telemetry → app_performance_events.
 */
import { OnecabTelemetry } from '@/lib/telemetry/core';
import {
  resolvePerformanceStepTiming,
  type PerformanceActionName,
  type RecordPerformanceStepInput,
  type PerformanceStepResult,
} from '../../shared/performanceHealthControl';

const adminPerfTelemetry = new OnecabTelemetry({
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  appName: 'admin_web',
  platform: 'web',
  appVersion: '1.0.0',
  maxValueMs: 60_000,
  thresholds: {
    screen_load_time: 0,
    api_latency: 0,
    render_time: 0,
    transaction_time: 0,
  },
});

export type { RecordPerformanceStepInput, PerformanceStepResult };

export function recordAdminPerformanceStep(
  input: Omit<RecordPerformanceStepInput, 'app' | 'platform'>,
): PerformanceStepResult {
  const resolved = resolvePerformanceStepTiming({
    ...input,
    app: 'admin_web',
    platform: 'web',
  });

  const payload = {
    action_name: input.action_name,
    flow_type: input.flow_type ?? 'admin_panel',
    duration_ms: resolved.duration_ms,
    p95_target_ms: resolved.p95_target_ms,
    timeout_budget_ms: resolved.timeout_budget_ms,
    performance_status: resolved.performance_status,
    success: input.success,
    error_code: input.error_code ?? null,
    started_at: input.started_at ?? null,
    completed_at: input.completed_at ?? null,
    ...(input.metadata ?? {}),
  };

  console.info('PERF_STEP_ADMIN', payload);

  adminPerfTelemetry.record('transaction_time', resolved.duration_ms, 'ms', input.action_name, payload);

  if (
    resolved.performance_status === 'PERF_WARNING'
    || resolved.performance_status === 'PERF_REGRESSION'
    || resolved.performance_status === 'PERF_TIMEOUT'
  ) {
    console.warn('[perfHealth] admin regression candidate', payload);
  }

  return resolved;
}

export function startAdminPerformanceStep(params: {
  action_name: PerformanceActionName;
  metadata?: Record<string, unknown>;
}): {
  started_at: number;
  complete: (
    result: Pick<RecordPerformanceStepInput, 'success' | 'error_code' | 'timed_out' | 'metadata'>,
  ) => PerformanceStepResult;
} {
  const started_at = Date.now();
  return {
    started_at,
    complete: (result) =>
      recordAdminPerformanceStep({
        ...params,
        ...result,
        started_at,
        completed_at: Date.now(),
        duration_ms: Date.now() - started_at,
      }),
  };
}
