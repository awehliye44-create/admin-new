/**
 * stop-workflow lifecycle Edge stage clock (Arrive / Start / Arrive Stop / Drive Next / Complete).
 * Observability only — never changes waiting / payment SSOT.
 */

export type StopWorkflowLifecycleStageName =
  | "edge_receive"
  | "auth_start"
  | "auth_end"
  | "reads_start"
  | "reads_end"
  | "validation_start"
  | "validation_end"
  | "waiting_ssot_start"
  | "waiting_ssot_end"
  | "canonical_mutation_start"
  | "canonical_mutation_end"
  | "CANONICAL_CONFIRMED"
  | "post_select_start"
  | "post_select_end"
  | "enrich_start"
  | "enrich_end"
  | "response_build_start"
  | "response_build_end"
  | "edge_response";

export type StopWorkflowLifecyclePerfClock = {
  mark: (name: StopWorkflowLifecycleStageName) => void;
  snapshot: () => Record<string, number>;
  durations: () => Record<string, number | null>;
};

function span(
  stages: Record<string, number>,
  start: StopWorkflowLifecycleStageName,
  end: StopWorkflowLifecycleStageName,
): number | null {
  const a = stages[start];
  const b = stages[end];
  if (typeof a !== "number" || typeof b !== "number") return null;
  return Math.max(0, b - a);
}

/** Non-overlapping derived durations for ops_logs / Driver ingest. */
export function deriveStopWorkflowLifecycleDurations(
  stages: Record<string, number>,
): Record<string, number | null> {
  const edge_auth_ms = span(stages, "auth_start", "auth_end");
  const edge_reads_ms = span(stages, "reads_start", "reads_end");
  const edge_validation_ms = span(stages, "validation_start", "validation_end");
  const edge_waiting_ssot_ms = span(stages, "waiting_ssot_start", "waiting_ssot_end");
  const edge_canonical_mutation_ms = span(
    stages,
    "canonical_mutation_start",
    "canonical_mutation_end",
  );
  const edge_post_select_ms = span(stages, "post_select_start", "post_select_end");
  const edge_enrich_ms = span(stages, "enrich_start", "enrich_end");
  const edge_response_build_ms = span(
    stages,
    "response_build_start",
    "response_build_end",
  );
  const edge_p0_ms =
    typeof stages.CANONICAL_CONFIRMED === "number" &&
      typeof stages.edge_receive === "number"
      ? Math.max(0, stages.CANONICAL_CONFIRMED - stages.edge_receive)
      : typeof stages.CANONICAL_CONFIRMED === "number"
      ? stages.CANONICAL_CONFIRMED
      : null;
  const edge_post_canonical_blocking_ms =
    typeof stages.CANONICAL_CONFIRMED === "number" &&
      typeof stages.edge_response === "number"
      ? Math.max(0, stages.edge_response - stages.CANONICAL_CONFIRMED)
      : null;
  const edge_total_ms =
    typeof stages.edge_response === "number"
      ? stages.edge_response
      : typeof stages.response_build_end === "number"
      ? stages.response_build_end
      : null;

  return {
    edge_auth_ms,
    edge_reads_ms,
    edge_validation_ms,
    edge_waiting_ssot_ms,
    edge_canonical_mutation_ms,
    edge_post_select_ms,
    edge_enrich_ms,
    edge_response_build_ms,
    edge_p0_ms,
    edge_post_canonical_blocking_ms,
    edge_total_ms,
  };
}

export function createStopWorkflowLifecyclePerfClock(
  elapsed: () => number,
): StopWorkflowLifecyclePerfClock {
  const stages: Record<string, number> = {};
  return {
    mark(name) {
      if (stages[name] != null) return;
      stages[name] = elapsed();
    },
    snapshot() {
      return { ...stages };
    },
    durations() {
      return deriveStopWorkflowLifecycleDurations(stages);
    },
  };
}

export function normalizeLifecyclePerfId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 64);
}
