/**
 * Bug #29 — ops_alerts rows for scheduled JIT / dispatch must include
 * NOT NULL columns (category, severity, source). Incomplete upserts were
 * swallowed and never alerted on hundreds of Module-not-found 500s.
 */

import type { AnySupabaseClient } from "./supabaseClientTypes.ts";

export type ScheduledJitOpsAlertInput = {
  fingerprint: string;
  title: string;
  related_trip_id?: string | null;
  metadata?: Record<string, unknown>;
  /** default: dispatch */
  category?: string;
  /** default: warning; use critical for HTTP 500 / overdue arm */
  severity?: "info" | "warning" | "critical";
  description?: string | null;
};

export function buildScheduledJitOpsAlertRow(
  input: ScheduledJitOpsAlertInput,
  nowIso: string = new Date().toISOString(),
): Record<string, unknown> {
  return {
    fingerprint: input.fingerprint,
    category: input.category ?? "dispatch",
    severity: input.severity ?? "warning",
    status: "open",
    source: "edge_function",
    app: "backend",
    title: input.title,
    description: input.description ?? null,
    related_trip_id: input.related_trip_id ?? null,
    related_entity_type: input.related_trip_id ? "trip" : null,
    related_entity_id: input.related_trip_id ?? null,
    metadata: input.metadata ?? {},
    last_detected_at: nowIso,
    updated_at: nowIso,
  };
}

/** Best-effort upsert; logs on failure so silent drops are visible in Edge logs. */
export async function upsertScheduledJitOpsAlert(
  supabase: AnySupabaseClient,
  input: ScheduledJitOpsAlertInput,
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const row = buildScheduledJitOpsAlertRow(input, nowIso);
  try {
    const { error } = await supabase.from("ops_alerts").upsert(row, {
      onConflict: "fingerprint",
      ignoreDuplicates: false,
    });
    if (!error) return true;
    // Partial unique index on open fingerprints — plain insert fallback.
    const { error: insertErr } = await supabase.from("ops_alerts").insert(row);
    if (!insertErr) return true;
    console.warn("[scheduled-jit] ops_alert write failed", {
      fingerprint: input.fingerprint,
      upsert: error.message,
      insert: insertErr.message,
    });
    return false;
  } catch (err) {
    console.warn("[scheduled-jit] ops_alert write threw", {
      fingerprint: input.fingerprint,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
