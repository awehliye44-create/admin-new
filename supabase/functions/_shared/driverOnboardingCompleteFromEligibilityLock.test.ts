/**
 * LOCK — document onboarding completion follows get_driver_document_eligibility.
 * Admin Document Review remains the existing workflow.
 *
 * Run: deno test --allow-read supabase/functions/_shared/driverOnboardingCompleteFromEligibilityLock.test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20260927180300_driver_onboarding_complete_from_eligibility.sql",
  import.meta.url,
);

Deno.test("document status trigger marks onboarding_complete from eligibility SSOT", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assertEquals(sql.includes("update_driver_document_status"), true);
  assertEquals(sql.includes("check_driver_documents_approved"), true);
  assertEquals(sql.includes("onboarding_complete = v_approved"), true);
  assertEquals(sql.includes("documents_approved = v_approved"), true);
  assertEquals(sql.includes("onboarding_complete = src.approved"), true);
});
