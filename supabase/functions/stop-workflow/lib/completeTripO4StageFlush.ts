/**
 * B4-0 / O4 — Complete Trip stage flush helpers (observability only).
 *
 * Merge lifecycle anchors into the complete-trip stage map and derive durations.
 * No I/O. Never blocks completion.
 */

import { deriveCompleteTripDurations } from "../../_shared/criticalPathPerfSSOT.ts";

/** Lifecycle marks copied into complete_trip_stages_ms for stall RCA joins. */
export const COMPLETE_TRIP_LIFECYCLE_ANCHORS = [
  "edge_receive",
  "auth_start",
  "auth_end",
  "reads_start",
  "reads_end",
] as const;

export function mergeCompleteTripLifecycleAnchors(
  completeStages: Record<string, number>,
  lifecycleStages: Record<string, number> | null | undefined,
): Record<string, number> {
  const out = { ...completeStages };
  if (!lifecycleStages) return out;
  for (const key of COMPLETE_TRIP_LIFECYCLE_ANCHORS) {
    const v = lifecycleStages[key];
    if (typeof v === "number" && Number.isFinite(v) && out[key] == null) {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Snapshot complete-trip stages + optional exit mark + lifecycle anchors.
 */
export function flushCompleteTripO4Stages(input: {
  completeStages: Record<string, number>;
  lifecycleStages?: Record<string, number> | null;
  exitMark?: string;
  exitAtMs?: number;
}): {
  stages_ms: Record<string, number>;
  complete_trip_durations_ms: Record<string, number | null>;
} {
  const stages = { ...input.completeStages };
  if (input.exitMark && typeof input.exitAtMs === "number") {
    if (stages[input.exitMark] == null) {
      stages[input.exitMark] = input.exitAtMs;
    }
  }
  const merged = mergeCompleteTripLifecycleAnchors(
    stages,
    input.lifecycleStages,
  );
  return {
    stages_ms: merged,
    complete_trip_durations_ms: deriveCompleteTripDurations(merged),
  };
}
