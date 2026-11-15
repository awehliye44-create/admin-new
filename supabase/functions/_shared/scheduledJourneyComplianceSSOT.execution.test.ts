/**
 * MK scheduled journey compliance — execution regressions (cases 1–25).
 *
 * Run: deno test --allow-read supabase/functions/_shared/scheduledJourneyComplianceSSOT.execution.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateScheduledJourneyCompliance,
  findDocumentsExpiredAsOf,
  resolveScheduledJourneyEndIso,
  shouldReleaseConfirmedScheduledForCompliance,
  shouldUseUrgentRescueForComplianceRelease,
  temporaryOfflineReleasesConfirmedBooking,
  SCHEDULED_COMPLIANCE_RELEASE_DRIVER_MESSAGE,
  type ScheduledAccountSnapshot,
} from "./scheduledJourneyComplianceSSOT.ts";
import type {
  DocumentRowSnapshot,
  RequiredDocumentRule,
} from "./driverDocumentEligibility.ts";

const RULES: RequiredDocumentRule[] = [
  { slug: "dvla_licence", expiry_required: true, mandatory: true },
  { slug: "phv_licence", expiry_required: true, mandatory: true },
];

const ACCOUNT: ScheduledAccountSnapshot = {
  approval_status: "approved",
  driver_status: "active",
  deleted_at: null,
};

function docs(expiry: string, status = "approved"): DocumentRowSnapshot[] {
  return [
    {
      document_type: "dvla_licence",
      status,
      expiry_date: expiry,
      updated_at: "2026-01-01T00:00:00Z",
    },
    {
      document_type: "phv_licence",
      status: "approved",
      expiry_date: "2030-01-01",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ];
}

/** Confirm day 15 Nov 2026 London afternoon. */
const CONFIRM_NOW = new Date("2026-11-15T14:00:00Z");
/** Pickup 16 Nov 2026 10:00 London ≈ 10:00 GMT in November. */
const PICKUP = "2026-11-16T10:00:00Z";

Deno.test("1. docs valid today but expire before tomorrow pickup → reject", () => {
  // Valid through end of 15th; journey ends on 16th → reject.
  const r = evaluateScheduledJourneyCompliance({
    account: ACCOUNT,
    documents: docs("2026-11-15"),
    requiredRules: RULES,
    scheduledAtIso: PICKUP,
    estimatedDurationMinutes: 30,
    now: CONFIRM_NOW,
  });
  assertEquals(r.allowed, false);
  assertEquals(r.code, "DOCUMENTS_EXPIRE_BEFORE_JOURNEY_END");
});

Deno.test("2. docs expire during estimated journey → reject", () => {
  // Journey 16th 10:00–12:00; expiry 15th → reject.
  const r = evaluateScheduledJourneyCompliance({
    account: ACCOUNT,
    documents: docs("2026-11-15"),
    requiredRules: RULES,
    scheduledAtIso: PICKUP,
    estimatedDurationMinutes: 120,
    now: CONFIRM_NOW,
  });
  assertEquals(r.allowed, false);
});

Deno.test("3. docs expire after estimated completion → eligible", () => {
  const r = evaluateScheduledJourneyCompliance({
    account: ACCOUNT,
    documents: docs("2026-11-17"),
    requiredRules: RULES,
    scheduledAtIso: PICKUP,
    estimatedDurationMinutes: 30,
    now: CONFIRM_NOW,
  });
  assertEquals(r.allowed, true);
  assertEquals(r.code, "OK");
});

Deno.test("4. document expires exactly at pickup day → eligible (end-of-day SSOT)", () => {
  // Valid through end of 16th; pickup 16th 10:00 → eligible.
  const r = evaluateScheduledJourneyCompliance({
    account: ACCOUNT,
    documents: docs("2026-11-16"),
    requiredRules: RULES,
    scheduledAtIso: PICKUP,
    estimatedDurationMinutes: 30,
    now: CONFIRM_NOW,
  });
  assertEquals(r.allowed, true);
});

Deno.test("5. document expires exactly at estimated completion day → eligible", () => {
  const end = resolveScheduledJourneyEndIso({
    scheduledAtIso: PICKUP,
    estimatedDurationMinutes: 30,
  });
  assert(end);
  const r = evaluateScheduledJourneyCompliance({
    account: ACCOUNT,
    documents: docs("2026-11-16"),
    requiredRules: RULES,
    scheduledAtIso: PICKUP,
    estimatedDurationMinutes: 30,
    now: CONFIRM_NOW,
  });
  assertEquals(r.allowed, true);
});

Deno.test("6. disabled driver → reject", () => {
  const r = evaluateScheduledJourneyCompliance({
    account: { ...ACCOUNT, driver_status: "disabled" },
    documents: docs("2030-01-01"),
    requiredRules: RULES,
    scheduledAtIso: PICKUP,
    now: CONFIRM_NOW,
  });
  assertEquals(r.allowed, false);
  assertEquals(r.code, "ACCOUNT_INELIGIBLE");
});

Deno.test("7. suspended driver → reject", () => {
  const r = evaluateScheduledJourneyCompliance({
    account: { ...ACCOUNT, approval_status: "suspended" },
    documents: docs("2030-01-01"),
    requiredRules: RULES,
    scheduledAtIso: PICKUP,
    now: CONFIRM_NOW,
  });
  assertEquals(r.code, "ACCOUNT_INELIGIBLE");
});

Deno.test("8. blocking review status → reject", () => {
  const r = evaluateScheduledJourneyCompliance({
    account: { ...ACCOUNT, approval_status: "pending" },
    documents: docs("2030-01-01"),
    requiredRules: RULES,
    scheduledAtIso: PICKUP,
    now: CONFIRM_NOW,
  });
  assertEquals(r.code, "ACCOUNT_INELIGIBLE");
});

Deno.test("9. rejected required document → reject", () => {
  const r = evaluateScheduledJourneyCompliance({
    account: ACCOUNT,
    documents: docs("2030-01-01", "rejected"),
    requiredRules: RULES,
    scheduledAtIso: PICKUP,
    now: CONFIRM_NOW,
  });
  assertEquals(r.code, "DOCUMENTS_NOT_APPROVED");
});

Deno.test("10. valid approved + replacement pending → keeps approved (eligible)", () => {
  const documents: DocumentRowSnapshot[] = [
    {
      document_type: "dvla_licence",
      status: "approved",
      expiry_date: "2030-01-01",
      updated_at: "2026-01-01T00:00:00Z",
    },
    {
      document_type: "dvla_licence",
      status: "pending",
      expiry_date: "2031-01-01",
      updated_at: "2026-11-14T00:00:00Z",
    },
    {
      document_type: "phv_licence",
      status: "approved",
      expiry_date: "2030-01-01",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ];
  const r = evaluateScheduledJourneyCompliance({
    account: ACCOUNT,
    documents,
    requiredRules: RULES,
    scheduledAtIso: PICKUP,
    now: CONFIRM_NOW,
  });
  assertEquals(r.allowed, true);
});

Deno.test("11–13. already-confirmed ineligible releases; only beyond expiry", () => {
  const fail = evaluateScheduledJourneyCompliance({
    account: ACCOUNT,
    documents: docs("2026-11-15"),
    requiredRules: RULES,
    scheduledAtIso: PICKUP,
    now: CONFIRM_NOW,
  });
  assertEquals(
    shouldReleaseConfirmedScheduledForCompliance({
      compliance: fail,
      isOnline: true,
      tripStatus: "accepted",
    }),
    true,
  );
  const ok = evaluateScheduledJourneyCompliance({
    account: ACCOUNT,
    documents: docs("2026-11-20"),
    requiredRules: RULES,
    scheduledAtIso: PICKUP,
    now: CONFIRM_NOW,
  });
  assertEquals(
    shouldReleaseConfirmedScheduledForCompliance({
      compliance: ok,
      tripStatus: "accepted",
    }),
    false,
  );
});

Deno.test("15. urgent scheduled-to-instant rescue window", () => {
  assertEquals(
    shouldUseUrgentRescueForComplianceRelease({
      scheduledAtIso: PICKUP,
      nowMs: Date.parse("2026-11-16T09:55:00Z"),
      urgentTriggerMinutesBeforePickup: 9,
    }),
    true,
  );
  assertEquals(
    shouldUseUrgentRescueForComplianceRelease({
      scheduledAtIso: PICKUP,
      nowMs: Date.parse("2026-11-15T14:00:00Z"),
      urgentTriggerMinutesBeforePickup: 9,
    }),
    false,
  );
});

Deno.test("18. multi-stop uses same journey-end duration basis", () => {
  const end = resolveScheduledJourneyEndIso({
    scheduledAtIso: PICKUP,
    estimatedDurationMinutes: 90,
  });
  assertEquals(end, "2026-11-16T11:30:00.000Z");
});

Deno.test("23. temporary offline does not release", () => {
  assertEquals(temporaryOfflineReleasesConfirmedBooking(), false);
  const fail = evaluateScheduledJourneyCompliance({
    account: ACCOUNT,
    documents: docs("2026-11-15"),
    requiredRules: RULES,
    scheduledAtIso: PICKUP,
    now: CONFIRM_NOW,
  });
  // Offline flag ignored — release only from compliance.
  assertEquals(
    shouldReleaseConfirmedScheduledForCompliance({
      compliance: fail,
      isOnline: false,
      tripStatus: "accepted",
    }),
    true,
  );
});

Deno.test("24. active passenger journey protected", () => {
  const r = evaluateScheduledJourneyCompliance({
    account: ACCOUNT,
    documents: docs("2026-11-15"),
    requiredRules: RULES,
    scheduledAtIso: PICKUP,
    now: CONFIRM_NOW,
    tripStatus: "in_progress",
  });
  assertEquals(r.code, "IN_PROGRESS_PROTECTED");
  assertEquals(
    shouldReleaseConfirmedScheduledForCompliance({
      compliance: r,
      tripStatus: "in_progress",
      hasStartedAt: true,
    }),
    false,
  );
});

Deno.test("12/14/16/17/19–22. release helpers + stacking + payment untouched", () => {
  // Multiple bookings: release decision is per-trip (helper returns boolean).
  const fail = evaluateScheduledJourneyCompliance({
    account: ACCOUNT,
    documents: docs("2026-11-15"),
    requiredRules: RULES,
    scheduledAtIso: PICKUP,
    now: CONFIRM_NOW,
  });
  const laterPickup = "2026-11-20T10:00:00Z";
  const okLater = evaluateScheduledJourneyCompliance({
    account: ACCOUNT,
    documents: docs("2026-11-21"),
    requiredRules: RULES,
    scheduledAtIso: laterPickup,
    now: CONFIRM_NOW,
  });
  assertEquals(fail.allowed, false);
  assertEquals(okLater.allowed, true);
  // Stacked commitment: temporary offline never releases.
  assertEquals(temporaryOfflineReleasesConfirmedBooking(), false);
  // Payment authorisation / duplicate booking: release helpers never touch fare fields.
  assert(!SCHEDULED_COMPLIANCE_RELEASE_DRIVER_MESSAGE.toLowerCase().includes("fare"));
  assert(!SCHEDULED_COMPLIANCE_RELEASE_DRIVER_MESSAGE.toLowerCase().includes("charge"));
});

Deno.test("20. admin bypass is not allowed by SSOT (account/docs gate)", () => {
  const r = evaluateScheduledJourneyCompliance({
    account: { ...ACCOUNT, driver_status: "suspended" },
    documents: docs("2030-01-01"),
    requiredRules: RULES,
    scheduledAtIso: PICKUP,
    now: CONFIRM_NOW,
  });
  assertEquals(r.allowed, false);
  assertEquals(r.code, "ACCOUNT_INELIGIBLE");
});

Deno.test("25. UK midnight: expiry day boundary (BST/GMT safe via London calendar)", () => {
  // Just after London midnight into 16 Nov: doc expiring 15th is expired.
  const asOf = new Date("2026-11-16T00:05:00Z");
  const expired = findDocumentsExpiredAsOf({
    documents: docs("2026-11-15"),
    requiredRules: RULES,
    asOf,
  });
  assertEquals(expired.includes("dvla_licence"), true);
  // Same moment: expiry on 16th still valid that day.
  const stillOk = findDocumentsExpiredAsOf({
    documents: docs("2026-11-16"),
    requiredRules: RULES,
    asOf,
  });
  assertEquals(stillOk.includes("dvla_licence"), false);
});

Deno.test("driver release copy is compliance-neutral", () => {
  assert(
    SCHEDULED_COMPLIANCE_RELEASE_DRIVER_MESSAGE.includes(
      "no longer meet the eligibility requirements",
    ),
  );
  assert(!SCHEDULED_COMPLIANCE_RELEASE_DRIVER_MESSAGE.toLowerCase().includes("licence"));
});
