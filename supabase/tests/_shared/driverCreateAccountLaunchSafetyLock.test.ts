/**
 * LOCK — Driver Create Account launch safety (Terms + single finalize writer).
 *
 * Run: deno test --allow-read supabase/functions/_shared/driverCreateAccountLaunchSafetyLock.test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20261028220000_driver_create_account_launch_safety.sql",
  import.meta.url,
);
const FORGE_GUARD = new URL(
  "../../migrations/20261028230000_driver_terms_forge_guard_and_grandfather.sql",
  import.meta.url,
);
const LEGACY = new URL(
  "../../migrations/20260817190000_finalize_driver_onboarding_registration.sql",
  import.meta.url,
);

Deno.test("launch safety migration enforces Terms + single writer + privileged guards", async () => {
  const sql = await Deno.readTextFile(MIGRATION);

  assertEquals(sql.includes("terms_accepted_at"), true);
  assertEquals(sql.includes("terms_version"), true);
  assertEquals(sql.includes("driver_legal_acceptances"), true);
  assertEquals(sql.includes("TERMS_ACCEPTANCE_REQUIRED"), true);
  assertEquals(sql.includes("p_terms_version"), true);
  assertEquals(sql.includes("COALESCE(public.drivers.terms_accepted_at"), true);
  assertEquals(sql.includes("Users can create own driver profile"), true);
  assertEquals(sql.includes("DROP POLICY IF EXISTS \"Users can create own driver profile\""), true);
  assertEquals(sql.includes("enforce_driver_privileged_column_guard"), true);
  assertEquals(sql.includes("DRIVER_PRIVILEGED_FIELD_FORBIDDEN"), true);
  assertEquals(sql.includes("approval_status"), true);
  assertEquals(sql.includes("onboarding_complete"), true);
  assertEquals(sql.includes("VEHICLE_REQUIRED"), true);
  assertEquals(sql.includes("validate_driver_signup_region_service_areas"), true);
  // No silent undefined_function skip for area validation.
  assertEquals(sql.includes("WHEN undefined_function THEN"), false);
});

Deno.test("Terms forge guard blocks client first-write; finalize arms GUC; grandfather NULL only", async () => {
  const sql = await Deno.readTextFile(FORGE_GUARD);
  assertEquals(sql.includes("onecab.allow_driver_terms_write"), true);
  assertEquals(sql.includes("grandfather_pre_driver_terms_v1"), true);
  assertEquals(sql.includes("AND d.terms_accepted_at IS NULL"), true);
  assertEquals(sql.includes("PERFORM set_config('onecab.allow_driver_terms_write', '1', true)"), true);
});

Deno.test("legacy finalize migration remains historical (replaced by launch safety)", async () => {
  const legacy = await Deno.readTextFile(LEGACY);
  assertEquals(legacy.includes("finalize_driver_onboarding_registration"), true);
});

Deno.test("later migrations do not re-open client drivers INSERT or legal-acceptances writes", async () => {
  const migrationsDir = new URL("../../migrations/", import.meta.url);
  const cutoff = "20261028220000";
  const entries: string[] = [];
  for await (const entry of Deno.readDir(migrationsDir)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    if (entry.name < cutoff) continue;
    // Launch-safety migration itself drops the policy — skip self.
    if (entry.name.startsWith(cutoff)) continue;
    entries.push(entry.name);
  }
  entries.sort();
  for (const name of entries) {
    const sql = await Deno.readTextFile(new URL(name, migrationsDir));
    assertEquals(
      /CREATE\s+POLICY[\s\S]{0,200}Users can create own driver profile/i.test(sql),
      false,
      `${name} must not recreate client drivers INSERT policy`,
    );
    assertEquals(
      /CREATE\s+POLICY[\s\S]{0,240}driver_legal_acceptances[\s\S]{0,120}FOR\s+INSERT/i.test(sql),
      false,
      `${name} must not add client INSERT on driver_legal_acceptances`,
    );
  }
});

Deno.test("privileged guard must not block presence writes (go-online path)", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20261028250000_fix_privileged_guard_presence_writes.sql",
      import.meta.url,
    ),
  );
  assertEquals(sql.includes("enforce_driver_privileged_column_guard"), true);
  assertEquals(sql.includes("tr_guard_driver_availability_columns"), true);
  assertEquals(sql.includes("allow_driver_availability_write"), true);
  // Must not re-forbid is_online / driver_online_intent in this fix migration.
  assertEquals(/IF NEW\.is_online IS DISTINCT FROM OLD\.is_online/.test(sql), false);
  assertEquals(
    /IF NEW\.driver_online_intent IS DISTINCT FROM OLD\.driver_online_intent/.test(sql),
    false,
  );
  // Still protects approval / onboarding / terms.
  assertEquals(sql.includes("approval_status"), true);
  assertEquals(sql.includes("onboarding_complete"), true);
  assertEquals(sql.includes("onecab.allow_driver_terms_write"), true);
});

Deno.test("finalize stamps approval_status pending on new driver rows", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20261028240000_finalize_stamp_approval_pending.sql",
      import.meta.url,
    ),
  );
  assertEquals(sql.includes("approval_status"), true);
  assertEquals(sql.includes("'pending'"), true);
  assertEquals(
    sql.includes("approval_status = COALESCE(public.drivers.approval_status, EXCLUDED.approval_status)"),
    true,
  );
  assertEquals(
    sql.includes("approval_status = COALESCE(d.approval_status, 'pending')"),
    true,
  );
});
