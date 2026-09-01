/**
 * LOCK — check_driver_documents_approved must read get_driver_document_eligibility.approved.
 * A drift to JSON key `eligible` (absent from the SSOT payload) left documents_approved
 * false for compliant drivers and enforce_online_eligibility blocked go-online.
 *
 * Run: deno test --allow-read supabase/functions/_shared/checkDriverDocumentsApprovedKeyLock.test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const FIX_MIGRATION = new URL(
  "../../migrations/20261028130000_fix_check_driver_documents_approved_key.sql",
  import.meta.url,
);

const SSOT_MIGRATION = new URL(
  "../../migrations/20260703191000_driver_document_compliance_payload_ssot.sql",
  import.meta.url,
);

Deno.test("check_driver_documents_approved reads approved from eligibility payload", async () => {
  const sql = await Deno.readTextFile(FIX_MIGRATION);
  assertEquals(sql.includes("get_driver_document_eligibility(p_driver_id)"), true);
  assertEquals(sql.includes("->> 'approved'"), true);
  assertEquals(sql.includes("->> 'eligible'"), true, "legacy eligible fallback only");
  assertEquals(sql.includes("documents_approved = src.approved"), true);
  assertEquals(sql.includes("onboarding_complete = src.approved"), true);
});

Deno.test("get_driver_document_eligibility SSOT exposes approved not eligible-only", async () => {
  const sql = await Deno.readTextFile(SSOT_MIGRATION);
  assertEquals(sql.includes("'approved', v_approved"), true);
  assertEquals(sql.includes("'eligible',"), false);
});
