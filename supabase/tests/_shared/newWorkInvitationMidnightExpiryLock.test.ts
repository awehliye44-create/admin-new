/**
 * Midnight Europe/London document expiry for new-work invitations.
 * Run: deno test --allow-read supabase/tests/_shared/newWorkInvitationMidnightExpiryLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateDriverDocumentStateFromSnapshot } from "../../functions/_shared/driverDocumentEligibility.ts";
import { evaluateNewWorkInvitationEligibilityFromParts } from "../../functions/_shared/newWorkInvitationEligibilitySSOT.ts";

Deno.test("doc valid through end of London expiry day; blocked after midnight", () => {
  const account = { approval_status: "approved", driver_status: "active" };
  const required = [{ slug: "phl_license", expiry_required: true }];

  // 2026-10-17 still London calendar day — not expired yet at 22:00 UTC (23:00 BST ended; Oct is BST historically but 2026 Oct 17 is BST? UK BST ends last Sunday Oct — 2026-10-25. So Oct 17 is BST = UTC+1. 22:00 UTC = 23:00 London — still on expiry day.
  const stillValid = evaluateDriverDocumentStateFromSnapshot({
    requiredRules: required,
    documents: [
      {
        document_type: "phl_license",
        status: "approved",
        expiry_date: "2026-10-17",
      },
    ],
    now: new Date("2026-10-17T22:30:00.000Z"),
  });
  assertEquals(stillValid.allowed, true);
  assertEquals(
    evaluateNewWorkInvitationEligibilityFromParts({
      account,
      documents: stillValid,
    }).ok,
    true,
  );

  // Next London calendar day after expiry — blocked.
  const expired = evaluateDriverDocumentStateFromSnapshot({
    requiredRules: required,
    documents: [
      {
        document_type: "phl_license",
        status: "approved",
        expiry_date: "2026-10-17",
      },
    ],
    now: new Date("2026-10-18T00:30:00.000+01:00"),
  });
  assertEquals(expired.allowed, false);
  assertEquals(expired.document_state, "documents_expired");
  const invite = evaluateNewWorkInvitationEligibilityFromParts({
    account,
    documents: expired,
  });
  assertEquals(invite.ok, false);
  if (!invite.ok) assertEquals(invite.reason, "documents_expired");
});
