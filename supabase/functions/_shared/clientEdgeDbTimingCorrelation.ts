/**
 * Batch O2 — correlate client, Edge and DB timing when keys align.
 * Pure analysis helper. No network / DB writes.
 *
 * Join keys (when present):
 * - client_action_id
 * - request_id / perf_id
 * - trip_suffix (last 4 of trip id) — privacy-safe; not a sole join
 */

export type ClientTimingSample = {
  client_action_id?: string | null;
  perf_id?: string | null;
  request_id?: string | null;
  trip_suffix?: string | null;
  client_total_ms: number;
  client_ui_ms?: number | null;
  client_edge_rtt_ms?: number | null;
  outcome?: string | null;
};

export type EdgeTimingSample = {
  client_action_id?: string | null;
  perf_id?: string | null;
  request_id?: string | null;
  trip_suffix?: string | null;
  edge_duration_ms: number;
  cold_start_hint?: boolean | null;
  stages_ms?: Record<string, number> | null;
  db_span_ms?: number | null;
};

export type CorrelatedTimingRow = {
  join_key: string;
  join_kind: "client_action_id" | "perf_id" | "request_id";
  client_total_ms: number;
  client_ui_ms: number | null;
  client_edge_rtt_ms: number | null;
  edge_duration_ms: number;
  /** client_edge_rtt − edge_duration (transport / queueing proxy). */
  transport_gap_ms: number | null;
  /** edge_duration − db_span when db_span present. */
  edge_non_db_ms: number | null;
  cold_start_hint: boolean | null;
  outcome: string | null;
};

function pickJoin(
  c: ClientTimingSample,
  e: EdgeTimingSample,
): { key: string; kind: CorrelatedTimingRow["join_kind"] } | null {
  if (
    c.client_action_id &&
    e.client_action_id &&
    c.client_action_id === e.client_action_id
  ) {
    return { key: c.client_action_id, kind: "client_action_id" };
  }
  if (c.perf_id && e.perf_id && c.perf_id === e.perf_id) {
    return { key: c.perf_id, kind: "perf_id" };
  }
  if (c.request_id && e.request_id && c.request_id === e.request_id) {
    return { key: c.request_id, kind: "request_id" };
  }
  return null;
}

/**
 * Pair client + Edge samples. Unmatched rows are omitted (not fabricated).
 * trip_suffix alone never joins — collision risk.
 */
export function correlateClientEdgeTimings(
  clients: readonly ClientTimingSample[],
  edges: readonly EdgeTimingSample[],
): CorrelatedTimingRow[] {
  const usedEdge = new Set<number>();
  const out: CorrelatedTimingRow[] = [];

  for (const c of clients) {
    for (let i = 0; i < edges.length; i++) {
      if (usedEdge.has(i)) continue;
      const e = edges[i]!;
      const join = pickJoin(c, e);
      if (!join) continue;
      usedEdge.add(i);
      const rtt = c.client_edge_rtt_ms ?? null;
      const db = e.db_span_ms ?? null;
      out.push({
        join_key: join.key,
        join_kind: join.kind,
        client_total_ms: c.client_total_ms,
        client_ui_ms: c.client_ui_ms ?? null,
        client_edge_rtt_ms: rtt,
        edge_duration_ms: e.edge_duration_ms,
        transport_gap_ms:
          rtt != null ? Math.max(0, Math.round(rtt - e.edge_duration_ms)) : null,
        edge_non_db_ms:
          db != null ? Math.max(0, Math.round(e.edge_duration_ms - db)) : null,
        cold_start_hint: e.cold_start_hint ?? null,
        outcome: c.outcome ?? null,
      });
      break;
    }
  }

  return out;
}

export function summarizeCorrelation(rows: readonly CorrelatedTimingRow[]): {
  n: number;
  n_with_transport_gap: number;
  n_cold_start: number;
  median_transport_gap_ms: number | null;
} {
  const gaps = rows
    .map((r) => r.transport_gap_ms)
    .filter((g): g is number => typeof g === "number")
    .sort((a, b) => a - b);
  const mid = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : null;
  return {
    n: rows.length,
    n_with_transport_gap: gaps.length,
    n_cold_start: rows.filter((r) => r.cold_start_hint === true).length,
    median_transport_gap_ms: mid,
  };
}
