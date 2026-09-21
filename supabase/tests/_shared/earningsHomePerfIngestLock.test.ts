/**
 * Lock: ingest-telemetry allowlists earnings home waterfall keys.
 * Run: deno test --allow-read supabase/tests/_shared/earningsHomePerfIngestLock.test.ts
 */
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ingestPath = new URL(
  "../../functions/ingest-telemetry/index.ts",
  import.meta.url,
);

Deno.test("ingest-telemetry allowlists earnings home waterfall keys", async () => {
  const ingest = await Deno.readTextFile(ingestPath);
  for (const key of [
    "earnings_path",
    "earnings_tap_to_mount_ms",
    "earnings_rows_ms",
    "earnings_summary_ms",
    "earnings_online_ms",
    "earnings_tap_to_first_useful_render_ms",
    "earnings_tap_to_interactive_ms",
    "earnings_chart_ready_ms",
    "earnings_recent_ready_ms",
    "earning_rows_returned",
    "recent_rows_rendered",
  ]) {
    assertStringIncludes(ingest, `"${key}"`);
  }
});
