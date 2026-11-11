/**
 * Lock: document_types create must not call ownership-gated recalc (FORBIDDEN).
 * Optional documents must never independently block Go Online (any status).
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateDriverDocumentStateFromSnapshot } from "./driverDocumentEligibility.ts";

const CREATE_MIGRATION = new URL(
  "../../migrations/20261231120000_document_type_create_recalc_and_optional_expiry_block.sql",
  import.meta.url,
);

const OPTIONAL_NEVER_BLOCK_MIGRATION = new URL(
  "../../migrations/20270101130000_optional_documents_never_block_go_online.sql",
  import.meta.url,
);

Deno.test("document type create migration uses internal recalc (no FORBIDDEN on insert)", async () => {
  const sql = await Deno.readTextFile(CREATE_MIGRATION);
  assertStringIncludes(sql, "recalculate_driver_documents_approved_internal");
  assertStringIncludes(sql, "seed_service_area_rules_for_document_type");
});

Deno.test("optional never-block migration removes optional expiry Go Online gate", async () => {
  const sql = await Deno.readTextFile(OPTIONAL_NEVER_BLOCK_MIGRATION);
  assertStringIncludes(sql, "get_driver_document_eligibility_internal");
  assertStringIncludes(sql, "never independently block");
  assertEquals(sql.includes("expired current row blocks"), false);
});

Deno.test("optional docs never block Go Online for any status; mandatory expired still blocks", () => {
  const baseMandatory = {
    document_type: "private_hire_insurance",
    status: "approved",
    expiry_date: "2099-01-01",
  } as const;

  const rules = [
    { slug: "private_hire_insurance", expiry_required: true, mandatory: true },
    { slug: "additional_insurance_document", expiry_required: true, mandatory: false },
    { slug: "exemption_certificate", expiry_required: true, mandatory: false },
  ];

  const statuses: Array<{
    name: string;
    doc: { document_type: string; status: string; expiry_date: string | null };
  }> = [
    {
      name: "missing",
      doc: {
        document_type: "additional_insurance_document",
        status: "approved",
        expiry_date: "2099-01-01",
      },
    },
    {
      name: "pending",
      doc: {
        document_type: "additional_insurance_document",
        status: "pending",
        expiry_date: "2099-01-01",
      },
    },
    {
      name: "approved",
      doc: {
        document_type: "additional_insurance_document",
        status: "approved",
        expiry_date: "2099-01-01",
      },
    },
    {
      name: "expired",
      doc: {
        document_type: "additional_insurance_document",
        status: "approved",
        expiry_date: "2020-01-01",
      },
    },
    {
      name: "rejected",
      doc: {
        document_type: "additional_insurance_document",
        status: "rejected",
        expiry_date: "2099-01-01",
      },
    },
    {
      name: "missing expiry",
      doc: {
        document_type: "additional_insurance_document",
        status: "approved",
        expiry_date: null,
      },
    },
  ];

  for (const row of statuses) {
    const documents =
      row.name === "missing"
        ? [baseMandatory]
        : [baseMandatory, row.doc];
    const result = evaluateDriverDocumentStateFromSnapshot({
      requiredRules: rules,
      documents,
    });
    assertEquals(result.allowed, true, `optional ${row.name} must not block`);
    assertEquals(result.expired_documents.includes("additional_insurance_document"), false);
  }

  const mandatoryExpired = evaluateDriverDocumentStateFromSnapshot({
    requiredRules: rules,
    documents: [
      {
        document_type: "private_hire_insurance",
        status: "approved",
        expiry_date: "2020-01-01",
      },
      {
        document_type: "additional_insurance_document",
        status: "approved",
        expiry_date: "2099-01-01",
      },
    ],
  });
  assertEquals(mandatoryExpired.allowed, false);
  assertEquals(mandatoryExpired.expired_documents, ["private_hire_insurance"]);

  const mandatoryRejected = evaluateDriverDocumentStateFromSnapshot({
    requiredRules: rules,
    documents: [
      {
        document_type: "private_hire_insurance",
        status: "rejected",
        expiry_date: "2099-01-01",
      },
    ],
  });
  assertEquals(mandatoryRejected.allowed, false);
  assertEquals(mandatoryRejected.rejected_documents, ["private_hire_insurance"]);

  const mandatoryMissing = evaluateDriverDocumentStateFromSnapshot({
    requiredRules: rules,
    documents: [],
  });
  assertEquals(mandatoryMissing.allowed, false);
  assertEquals(mandatoryMissing.missing_documents.includes("private_hire_insurance"), true);
});
