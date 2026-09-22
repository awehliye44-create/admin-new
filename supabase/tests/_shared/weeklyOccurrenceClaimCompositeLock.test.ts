/**
 * Lock: weekly occurrence claim uses composite (schedule_occurrence_key, dry_run)
 * uniqueness. Claim failures are OCCURRENCE_CLAIM_FAILED, never SCHEDULER_NOT_INVOKED.
 *
 *   deno test --allow-read supabase/tests/_shared/weeklyOccurrenceClaimCompositeLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyWeeklyOccurrenceClaimFailure,
  ORCHESTRATOR_CLAIM_ERROR,
} from "../../functions/_shared/weeklyPayoutOrchestratorSSOT.ts";

const ROOT = new URL("../../", import.meta.url);

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, ROOT));
}

Deno.test("1. new migration ON CONFLICT matches composite unique, not single-column", async () => {
  const sql = await read(
    "migrations/20261124150000_claim_weekly_payout_occurrence_composite_conflict.sql",
  );
  assertStringIncludes(sql, "ON CONFLICT (schedule_occurrence_key, dry_run) DO NOTHING");
  assertStringIncludes(sql, "AND dry_run = v_dry");
  assertStringIncludes(sql, "uq_weekly_payout_occurrence_runs_key_dry");
  assertEquals(sql.includes("ON CONFLICT (schedule_occurrence_key) DO NOTHING"), false);
  assertStringIncludes(
    sql,
    "DROP CONSTRAINT IF EXISTS weekly_payout_occurrence_runs_schedule_occurrence_key_key",
  );
});

Deno.test("2. canonical 20260832010000 is left unchanged (already applied, wrong ON CONFLICT)", async () => {
  const sql = await read(
    "migrations/20260832010000_weekly_payout_orchestrator_claim_cron.sql",
  );
  assertStringIncludes(sql, "ON CONFLICT (schedule_occurrence_key) DO NOTHING");
  assertStringIncludes(
    sql,
    "CONSTRAINT weekly_payout_occurrence_runs_schedule_occurrence_key_key UNIQUE (schedule_occurrence_key)",
  );
});

Deno.test("3. execute maps claim RPC failure to OCCURRENCE_CLAIM_FAILED, never SCHEDULER_NOT_INVOKED", async () => {
  const src = await read("functions/admin-execute-weekly-payout-occurrence/index.ts");
  assertStringIncludes(src, "classifyWeeklyOccurrenceClaimFailure");
  assertEquals(src.includes("SCHEDULER_NOT_INVOKED"), false);
  assertEquals(src.includes("Apply migration 20260832010000"), false);
  const classified = classifyWeeklyOccurrenceClaimFailure({
    message: "there is no unique or exclusion constraint matching the ON CONFLICT specification",
  });
  assertEquals(classified.error, ORCHESTRATOR_CLAIM_ERROR.OCCURRENCE_CLAIM_FAILED);
  assertEquals(classified.error_code, "OCCURRENCE_CLAIM_FAILED");
  assertEquals(classified.classification, "OCCURRENCE_CLAIM_FAILED");
  assertEquals(classified.success, false);
  assertEquals(JSON.stringify(classified).includes("SCHEDULER_NOT_INVOKED"), true);
});

Deno.test("4. scheduler still only forwards to execute; it does not claim", async () => {
  const src = await read("functions/admin-weekly-payout-scheduler/index.ts");
  assertStringIncludes(src, "admin-execute-weekly-payout-occurrence");
  assertEquals(src.includes("claim_weekly_payout_occurrence"), false);
});

Deno.test("5. migration does not touch payout/wallet/provider writers", async () => {
  const sql = await read(
    "migrations/20261124160000_weekly_payout_occurrence_period_scope.sql",
  );
  assertStringIncludes(sql, "ON CONFLICT (schedule_occurrence_key, dry_run) DO NOTHING");
  const body = sql.replace(/--[^\n]*/g, "");
  for (const forbidden of [
    "INSERT INTO public.payout_",
    "UPDATE public.payout_",
    "INSERT INTO public.driver_payout_",
    "UPDATE public.driver_wallet_ledger",
    "reserve_driver_payout_item",
    "finalize_driver_payout_completion",
  ]) {
    assertEquals(body.includes(forbidden), false, forbidden);
  }
});

Deno.test("5b. composite-conflict migration still does not touch payout/wallet/provider writers", async () => {
  const sql = await read(
    "migrations/20261124150000_claim_weekly_payout_occurrence_composite_conflict.sql",
  );
  const body = sql.replace(/--[^\n]*/g, "");
  for (const forbidden of [
    "INSERT INTO public.payout_",
    "UPDATE public.payout_",
    "INSERT INTO public.driver_payout_",
    "UPDATE public.driver_wallet_ledger",
    "reserve_driver_payout_item",
    "finalize_driver_payout_completion",
  ]) {
    assertEquals(body.includes(forbidden), false, forbidden);
  }
});
