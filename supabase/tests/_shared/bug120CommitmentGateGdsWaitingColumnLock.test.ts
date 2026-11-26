/**
 * #120 — commitment gate must not SELECT a non-existent GDS column.
 * pickup_waiting_grace_period_seconds is on dispatch_settings only.
 * GDS SSOT for commitment waiting: expected_pickup_waiting_minutes.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL("../../" + path, import.meta.url));
}

Deno.test("#120 SQL gate migration never reads GDS pickup_waiting_grace_period_seconds", async () => {
  const sql = await read(
    "migrations/20270304150000_bug120_commitment_gate_gds_waiting_column_fix.sql",
  );
  assert(!/gds\.pickup_waiting_grace_period_seconds/.test(sql));
  assertStringIncludes(sql, "expected_pickup_waiting_minutes");
  assertStringIncludes(sql, "waiting_time_grace_period_minutes");
  assertStringIncludes(sql, "driver_scheduled_commitment_gate");
});

Deno.test("#120 accept-offer GDS select uses minutes columns, not grace seconds", async () => {
  const accept = await read("functions/accept-offer/index.ts");
  assertStringIncludes(accept, "expected_pickup_waiting_minutes");
  assertStringIncludes(accept, "waiting_time_grace_period_minutes");
  // Must not select the SA-only seconds column from global_dispatch_settings.
  const gdsSelect = accept.match(
    /\.from\(\s*["']global_dispatch_settings["']\s*\)[\s\S]{0,400}?\.select\(\s*[\s\S]*?\)/,
  );
  assert(gdsSelect, "accept-offer must select from global_dispatch_settings");
  assert(
    !/pickup_waiting_grace_period_seconds/.test(gdsSelect[0]),
    "accept-offer GDS select must not request pickup_waiting_grace_period_seconds",
  );
});

Deno.test("#120 resolveCommitmentPickupWaitingMinutes prefers expected minutes", async () => {
  const { resolveCommitmentPickupWaitingMinutes } = await import(
    "../../functions/_shared/scheduledCommitmentFeasibilitySSOT.ts"
  );
  assertEquals(
    resolveCommitmentPickupWaitingMinutes({
      expected_pickup_waiting_minutes: 7,
      pickup_waiting_grace_period_seconds: 180,
    }),
    7,
  );
  assertEquals(
    resolveCommitmentPickupWaitingMinutes({
      waiting_time_grace_period_minutes: 4,
    }),
    4,
  );
  assertEquals(
    resolveCommitmentPickupWaitingMinutes({
      pickup_waiting_grace_period_seconds: 180,
    }),
    3,
  );
});
