/**
 * LOCK — MK0006 offer flash then revoke.
 * Realtime showed the card; push-gate revoked ineligible_before_push:documents_expired
 * because pickBestDocumentForSlug preferred a superseded expired row that shared
 * updated_at with the current valid approved row after vehicle stamp.
 * If this fails, fix driverDocumentEligibility — never delete or soften the lock.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateDriverDocumentStateFromSnapshot,
  pickBestDocumentForSlug,
} from "../../functions/_shared/driverDocumentEligibility.ts";

const NOW = new Date("2026-11-28T15:44:22.000Z");
const TIE = "2026-11-28T12:46:16.307619+00:00";

Deno.test("pickBestDocument prefers current non-expired over superseded expired with same updated_at", () => {
  const best = pickBestDocumentForSlug(
    [
      {
        document_type: "private_hire_insurance",
        status: "approved",
        expiry_date: "2026-10-31",
        is_current: false,
        updated_at: TIE,
      },
      {
        document_type: "private_hire_insurance",
        status: "approved",
        expiry_date: "2026-11-30",
        is_current: true,
        updated_at: TIE,
      },
      {
        document_type: "private_hire_insurance",
        status: "approved",
        expiry_date: "2026-09-12",
        is_current: false,
        updated_at: TIE,
      },
    ],
    "private_hire_insurance",
    NOW,
  );
  assertEquals(best?.expiry_date, "2026-11-30");
  assertEquals(best?.is_current, true);
});

Deno.test("MK0006-shaped snapshot stays documents_approved (expiring soon ≠ expired)", () => {
  const result = evaluateDriverDocumentStateFromSnapshot({
    now: NOW,
    requiredRules: [
      { slug: "private_hire_insurance", expiry_required: true, mandatory: true },
      { slug: "mot_certificate", expiry_required: true, mandatory: true },
      { slug: "phv_license", expiry_required: true, mandatory: true },
      { slug: "phl_license", expiry_required: true, mandatory: true },
      { slug: "dvla_driving_license", expiry_required: true, mandatory: true },
      { slug: "profile_photo", expiry_required: false, mandatory: true },
      { slug: "v5_logbook", expiry_required: false, mandatory: true },
      { slug: "national_insurance", expiry_required: false, mandatory: true },
    ],
    documents: [
      {
        document_type: "private_hire_insurance",
        status: "approved",
        expiry_date: "2026-11-30",
        is_current: true,
        updated_at: TIE,
      },
      {
        document_type: "private_hire_insurance",
        status: "approved",
        expiry_date: "2026-10-31",
        is_current: false,
        updated_at: TIE,
      },
      {
        document_type: "phv_license",
        status: "approved",
        expiry_date: "2026-11-29",
        is_current: true,
        updated_at: TIE,
      },
      {
        document_type: "phv_license",
        status: "approved",
        expiry_date: "2026-10-23",
        is_current: false,
        updated_at: TIE,
      },
      {
        document_type: "mot_certificate",
        status: "approved",
        expiry_date: "2026-12-31",
        is_current: true,
        updated_at: TIE,
      },
      {
        document_type: "phl_license",
        status: "approved",
        expiry_date: "2026-12-06",
        is_current: true,
        updated_at: "2026-11-24T14:22:17.793875+00:00",
      },
      {
        document_type: "dvla_driving_license",
        status: "approved",
        expiry_date: "2026-11-30",
        is_current: true,
        updated_at: "2026-11-02T07:07:44.654432+00:00",
      },
      {
        document_type: "profile_photo",
        status: "approved",
        expiry_date: null,
        is_current: true,
        updated_at: "2026-09-05T08:39:55.189124+00:00",
      },
      {
        document_type: "v5_logbook",
        status: "approved",
        expiry_date: null,
        is_current: true,
        updated_at: TIE,
      },
      {
        document_type: "national_insurance",
        status: "approved",
        expiry_date: null,
        is_current: true,
        updated_at: "2026-09-05T08:40:17.628037+00:00",
      },
    ],
  });

  assertEquals(result.allowed, true);
  assertEquals(result.document_state, "documents_approved");
  assertEquals(result.expired_documents, []);
});
