/**
 * Lock: document re-reject / compliance loss must clear driver_online_intent
 * (not only is_online). Sticky intent left Home Online while the documents
 * banner correctly asked for replacements (MK0006).
 */
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20261231184000_force_offline_clear_intent_on_document_ineligibility.sql",
  import.meta.url,
);

Deno.test("document ineligibility clears online intent and presence", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assertStringIncludes(sql, "force_driver_offline_for_document_ineligibility");
  assertStringIncludes(sql, "driver_online_intent = false");
  assertStringIncludes(sql, "documents_ineligible");
  assertStringIncludes(sql, "update_driver_document_status");
  assertStringIncludes(sql, "recalculate_driver_documents_approved_internal");
  assertStringIncludes(
    sql,
    "Clears driver_online_intent so Home cannot stay Online/Reconnecting",
  );
});
