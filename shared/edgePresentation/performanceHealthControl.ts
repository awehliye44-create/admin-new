/** Admin presentation-only helpers; not part of Edge uploads. */
import { RecordPerformanceStepInput, PerformanceStepResult, P95_TARGET_MS, timeoutBudgetForAction, evaluatePerformanceStatus } from "../../supabase/functions/_shared/performanceHealthControl.ts";


export function resolvePerformanceStepTiming(input: RecordPerformanceStepInput): PerformanceStepResult {
  const p95_target_ms = input.p95_target_ms ?? P95_TARGET_MS[input.action_name] ?? 2_000;
  const timeout_budget_ms =
    input.timeout_budget_ms ?? timeoutBudgetForAction(input.action_name);

  let duration_ms = input.duration_ms;
  if (duration_ms == null && input.started_at != null && input.completed_at != null) {
    const start =
      typeof input.started_at === 'number'
        ? input.started_at
        : new Date(input.started_at).getTime();
    const end =
      typeof input.completed_at === 'number'
        ? input.completed_at
        : new Date(input.completed_at).getTime();
    duration_ms = end - start;
  }
  duration_ms = Math.max(0, Math.round(duration_ms ?? 0));

  const performance_status = evaluatePerformanceStatus({
    duration_ms,
    p95_target_ms,
    timeout_budget_ms,
    success: input.success,
    timed_out: input.timed_out,
  });

  return { duration_ms, p95_target_ms, timeout_budget_ms, performance_status };
}

export * from "../../supabase/functions/_shared/performanceHealthControl.ts";
