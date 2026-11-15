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

/**
 * Best-effort write. Prefer update-of-open-row then insert.
 * Partial unique index is on (fingerprint) WHERE status IN (open, acknowledged)
 * — PostgREST onConflict:"fingerprint" is unreliable against partial uniques.
 */
export async function upsertScheduledJitOpsAlert(
  supabase: AnySupabaseClient,
  input: ScheduledJitOpsAlertInput,
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const row = buildScheduledJitOpsAlertRow(input, nowIso);
  try {
    const { data: existing, error: selErr } = await supabase
      .from("ops_alerts")
      .select("id, fingerprint_count")
      .eq("fingerprint", input.fingerprint)
      .in("status", ["open", "acknowledged"])
      .maybeSingle();
    if (!selErr && existing?.id) {
      const nextCount = Math.max(1, Number(existing.fingerprint_count) || 1) + 1;
      const { error: updErr } = await supabase
        .from("ops_alerts")
        .update({
          title: row.title,
          description: row.description,
          severity: row.severity,
          metadata: row.metadata,
          related_trip_id: row.related_trip_id,
          related_entity_type: row.related_entity_type,
          related_entity_id: row.related_entity_id,
          fingerprint_count: nextCount,
          last_detected_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", existing.id);
      if (!updErr) return true;
      console.warn("[scheduled-jit] ops_alert update failed", {
        fingerprint: input.fingerprint,
        error: updErr.message,
      });
    }

    const { error: insertErr } = await supabase.from("ops_alerts").insert(row);
    if (!insertErr) return true;
    console.warn("[scheduled-jit] ops_alert insert failed", {
      fingerprint: input.fingerprint,
      error: insertErr.message,
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
