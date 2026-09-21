/**
 * Lock: ingest-telemetry allowlists wallet home waterfall keys.
 * Run: deno test --allow-read supabase/tests/_shared/walletHomePerfIngestLock.test.ts
 */
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ingestPath = new URL(
  "../../functions/ingest-telemetry/index.ts",
  import.meta.url,
);

Deno.test("ingest-telemetry allowlists wallet home waterfall keys", async () => {
  const ingest = await Deno.readTextFile(ingestPath);
  for (const key of [
    "wallet_path",
    "wallet_tap_to_mount_ms",
    "wallet_balance_ms",
    "wallet_withdraw_quote_ms",
    "wallet_history_first_page_ms",
    "wallet_secondary_ms",
    "wallet_tap_to_first_useful_render_ms",
    "wallet_tap_to_interactive_ms",
    "network_request_count",
    "history_rows_returned",
  ]) {
    assertStringIncludes(ingest, `"${key}"`);
  }
});
