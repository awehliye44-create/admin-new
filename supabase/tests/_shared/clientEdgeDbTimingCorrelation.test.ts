/**
 * Batch O2 — client/Edge/DB correlation helper.
 * Run: deno test --allow-read supabase/tests/_shared/clientEdgeDbTimingCorrelation.test.ts
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  correlateClientEdgeTimings,
  summarizeCorrelation,
} from "../../functions/_shared/clientEdgeDbTimingCorrelation.ts";

Deno.test("correlates on client_action_id and derives transport gap", () => {
  const rows = correlateClientEdgeTimings(
    [
      {
        client_action_id: "a1",
        client_total_ms: 900,
        client_ui_ms: 80,
        client_edge_rtt_ms: 700,
        outcome: "success",
      },
    ],
    [
      {
        client_action_id: "a1",
        edge_duration_ms: 520,
        cold_start_hint: false,
        db_span_ms: 200,
      },
    ],
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0]!.transport_gap_ms, 180);
  assertEquals(rows[0]!.edge_non_db_ms, 320);
  assertEquals(rows[0]!.join_kind, "client_action_id");
});

Deno.test("does not join on trip_suffix alone", () => {
  const rows = correlateClientEdgeTimings(
    [{ trip_suffix: "abcd", client_total_ms: 100, client_edge_rtt_ms: 90 }],
    [{ trip_suffix: "abcd", edge_duration_ms: 50 }],
  );
  assertEquals(rows.length, 0);
});

Deno.test("summarizeCorrelation counts cold starts", () => {
  const rows = correlateClientEdgeTimings(
    [
      { perf_id: "p1", client_total_ms: 100, client_edge_rtt_ms: 80 },
      { perf_id: "p2", client_total_ms: 200, client_edge_rtt_ms: 150 },
    ],
    [
      { perf_id: "p1", edge_duration_ms: 60, cold_start_hint: true },
      { perf_id: "p2", edge_duration_ms: 100, cold_start_hint: false },
    ],
  );
  const summary = summarizeCorrelation(rows);
  assertEquals(summary.n, 2);
  assertEquals(summary.n_cold_start, 1);
});
