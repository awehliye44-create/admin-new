/**
 * Lock: document_types create must not call ownership-gated recalc (FORBIDDEN).
 * Optional + expiry_required must still block when a current row is expired.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateDriverDocumentStateFromSnapshot } from "./driverDocumentEligibility.ts";

const MIGRATION = new URL(
  "../../migrations/20261231120000_document_type_create_recalc_and_optional_expiry_block.sql",
  import.meta.url,
);

Deno.test("document type create migration uses internal recalc (no FORBIDDEN on insert)", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assertStringIncludes(sql, "recalculate_driver_documents_approved_internal");
  assertStringIncludes(sql, "seed_service_area_rules_for_document_type");
  assertStringIncludes(sql, "sar.mandatory = false");
  assertStringIncludes(sql, "expiry_required");
});

Deno.test("optional expiry-required missing does not block; expired current row blocks", () => {
  const missingOk = evaluateDriverDocumentStateFromSnapshot({
    requiredRules: [
      { slug: "private_hire_insurance", expiry_required: true, mandatory: true },
      { slug: "additional_insurance_document", expiry_required: true, mandatory: false },
    ],
    documents: [
      {
        document_type: "private_hire_insurance",
        status: "approved",
        expiry_date: "2099-01-01",
      },
    ],
  });
  assertEquals(missingOk.allowed, true);
  assertEquals(missingOk.expired_documents, []);

  const expiredBlocks = evaluateDriverDocumentStateFromSnapshot({
    requiredRules: [
      { slug: "private_hire_insurance", expiry_required: true, mandatory: true },
      { slug: "additional_insurance_document", expiry_required: true, mandatory: false },
    ],
    documents: [
      {
        document_type: "private_hire_insurance",
        status: "approved",
        expiry_date: "2099-01-01",
      },
      {
        document_type: "additional_insurance_document",
        status: "approved",
        expiry_date: "2020-01-01",
      },
    ],
  });
  assertEquals(expiredBlocks.allowed, false);
  assertEquals(expiredBlocks.expired_documents, ["additional_insurance_document"]);
});
