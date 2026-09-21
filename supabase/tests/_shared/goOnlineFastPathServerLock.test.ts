/**
 * Lock: driver_request_go_online server timing keys (observational only).
 * Eligibility / presence semantics must remain fail-closed and unchanged.
 *
 * Run: deno test --allow-read supabase/tests/_shared/goOnlineFastPathServerLock.test.ts
 */
import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migrationPath = new URL(
  "../../migrations/20261122150000_go_online_server_timing.sql",
  import.meta.url,
);
const ingestPath = new URL(
  "../../functions/ingest-telemetry/index.ts",
  import.meta.url,
);

Deno.test("go_online RPC timing migration keeps fail-closed eligibility", async () => {
  const sql = await Deno.readTextFile(migrationPath);
  assertStringIncludes(sql, "assert_driver_presence_online_eligible");
  assertStringIncludes(sql, "driver_online_intent = true");
  assertStringIncludes(sql, "is_online = true");
  assertStringIncludes(sql, "status = 'online'");
  assertStringIncludes(sql, "go_online_server_total_ms");
  assertStringIncludes(sql, "go_online_server_eligibility_ms");
  assertStringIncludes(sql, "go_online_server_presence_ms");
  assertStringIncludes(sql, "'ok', false");
  assertStringIncludes(sql, "ONLINE_ELIGIBILITY_BLOCKED");
});

Deno.test("ingest-telemetry allowlists go-online waterfall keys", async () => {
  const ingest = await Deno.readTextFile(ingestPath);
  for (const key of [
    "go_online_path",
    "go_online_tap_to_interactive_ms",
    "go_online_permission_ms",
    "go_online_location_ms",
    "go_online_push_readiness_ms",
    "go_online_precanonical_ms",
    "go_online_rpc_ms",
    "go_online_canonical_confirmed_ms",
    "go_online_postcanonical_ms",
    "go_online_response_to_state_ms",
    "go_online_state_to_interactive_ms",
    "go_online_server_total_ms",
    "go_online_server_eligibility_ms",
    "go_online_server_presence_ms",
    "still_checking_shown",
    "still_checking_after_ms",
  ]) {
    assertStringIncludes(ingest, `"${key}"`);
  }
});
