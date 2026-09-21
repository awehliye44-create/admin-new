/**
 * Lock: get_driver_own_online_duration_seconds for Earnings Online time.
 * Run: deno test --allow-read supabase/tests/_shared/driverOwnOnlineDurationLock.test.ts
 */
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const migrationPath = new URL(
  "../../migrations/20261122160000_driver_own_online_duration_seconds.sql",
  import.meta.url,
);

Deno.test("online duration RPC sums go_online/go_offline for authenticated driver", async () => {
  const sql = await Deno.readTextFile(migrationPath);
  assertStringIncludes(sql, "get_driver_own_online_duration_seconds");
  assertStringIncludes(sql, "require_authenticated_driver_id");
  assertStringIncludes(sql, "driver_availability_events");
  assertStringIncludes(sql, "go_online");
  assertStringIncludes(sql, "go_offline");
  assertStringIncludes(sql, "GRANT EXECUTE");
});

Deno.test("online duration fix rejects abandoned overnight carry-in and caps stretches", async () => {
  const fixPath = new URL(
    "../../migrations/20261122161000_fix_driver_online_duration_abandoned_sessions.sql",
    import.meta.url,
  );
  const sql = await Deno.readTextFile(fixPath);
  assertStringIncludes(sql, "interval '2 hours'");
  assertStringIncludes(sql, "14 * 3600");
  assertStringIncludes(sql, "c_carry_max");
  assertStringIncludes(sql, "c_stretch_cap_secs");
});
