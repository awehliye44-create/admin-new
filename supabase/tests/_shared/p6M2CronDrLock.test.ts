/**
 * P6 M2 — cron DR: stale-hold + pending-invoice sweeps versioned in migrations.
 * If these fail, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const mig = await Deno.readTextFile(
  new URL(
    "../../migrations/20270302091000_p6_m2_cron_dr_stale_holds_and_pending_invoices.sql",
    import.meta.url,
  ),
);
const inventory = JSON.parse(
  await Deno.readTextFile(new URL("../../../scripts/financial_production_worker_inventory.json", import.meta.url)),
) as { financial_cron_consumers: Array<{ jobname: string; invokes: string; mechanism: string }> };

Deno.test("jobs match the production worker inventory (names + invoked function)", () => {
  for (const [jobname, invokes] of [
    ["sweep-revolut-stale-holds-every-5min", "sweep-revolut-stale-holds"],
    ["sweep-pending-trip-invoices-every-5min", "sweep-pending-trip-invoices"],
  ]) {
    const entry = inventory.financial_cron_consumers.find((c) => c.jobname === jobname);
    assert(entry, `${jobname} must exist in inventory`);
    assertEquals(entry.invokes, invokes);
    assertStringIncludes(mig, `'${jobname}'`);
  }
});

Deno.test("both jobs run every 5 minutes", () => {
  const matches = mig.match(/'\*\/5 \* \* \* \*'/g) ?? [];
  assert(matches.length >= 4, "schedule used for create and drift-fix of both jobs");
});

Deno.test("idempotent: existing jobs are looked up by jobname, never duplicated or rewritten", () => {
  assertStringIncludes(mig, "FROM cron.job WHERE jobname = 'sweep-revolut-stale-holds-every-5min'");
  assertStringIncludes(mig, "FROM cron.job WHERE jobname = 'sweep-pending-trip-invoices-every-5min'");
  assertStringIncludes(mig, "cron.alter_job(v_job_id, schedule :=");
  assert(!/alter_job\([^)]*command/i.test(mig), "existing job commands are never rewritten");
  assert(!/cron\.unschedule/i.test(mig), "no unschedule");
  assertEquals((mig.match(/cron\.schedule\(/g) ?? []).length, 2, "exactly one create path per job");
  assertStringIncludes(mig, "to_regnamespace('cron') IS NULL");
});

Deno.test("sweep_revolut_stale_holds() defined verbatim: Edge POST, auth token, postgres-only ACL", () => {
  assertStringIncludes(mig, "CREATE OR REPLACE FUNCTION public.sweep_revolut_stale_holds()");
  assertStringIncludes(mig, "SECURITY DEFINER");
  assertStringIncludes(mig, "functions/v1/sweep-revolut-stale-holds");
  assertStringIncludes(mig, "public.cron_edge_auth_token()");
  assertStringIncludes(mig, "net.http_post(");
  for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
    assertStringIncludes(mig, `REVOKE ALL ON FUNCTION public.sweep_revolut_stale_holds() FROM ${role};`);
  }
  assert(!/GRANT EXECUTE ON FUNCTION public\.sweep_revolut_stale_holds/i.test(mig));
});

Deno.test("invoice job uses vault service_role_key + net.http_post; no money mutation in migration", () => {
  assertStringIncludes(mig, "vault.decrypted_secrets");
  assertStringIncludes(mig, "name = 'service_role_key'");
  assertStringIncludes(mig, "functions/v1/sweep-pending-trip-invoices");
  assert(!/INSERT INTO public\.(driver_wallet_ledger|payout|payment_sessions)/i.test(mig));
  assert(!/UPDATE public\.(trips|payment_sessions|driver_wallet_ledger)/i.test(mig));
  assert(!/stripe/i.test(mig));
});
