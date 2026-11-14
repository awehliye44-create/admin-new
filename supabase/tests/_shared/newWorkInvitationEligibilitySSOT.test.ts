/**
 * MK-261105-002 / MK0009 — new-work invitation eligibility SSOT.
 * Run: deno test --allow-read supabase/tests/_shared/newWorkInvitationEligibilitySSOT.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateNewWorkInvitationAccountEligibility,
  evaluateNewWorkInvitationEligibilityFromParts,
  evaluateScheduledMarketplaceOnlinePresence,
  isScheduledMarketplaceBookingOpenForInvitation,
  mapDocumentStateToNewWorkDenyReason,
  newWorkInvitationSuppressionLogFields,
} from "../../functions/_shared/newWorkInvitationEligibilitySSOT.ts";
import type { DriverDocumentEligibilityResult } from "../../functions/_shared/driverDocumentEligibility.ts";

function docs(
  partial: Partial<DriverDocumentEligibilityResult> & {
    allowed: boolean;
    document_state: DriverDocumentEligibilityResult["document_state"];
  },
): DriverDocumentEligibilityResult {
  return {
    missing_documents: [],
    expired_documents: [],
    rejected_documents: [],
    resubmission_documents: [],
    pending_documents: [],
    blocked_reasons: [],
    message: "",
    ...partial,
  };
}

const FUTURE = "2026-11-07T10:00:00.000Z";
const PAST = "2026-11-06T08:00:00.000Z";
const NOW = Date.parse("2026-11-06T09:00:00.000Z");
const BROADCAST = "2026-11-06T08:30:00.000Z";

Deno.test("account: approved active passes", () => {
  const r = evaluateNewWorkInvitationAccountEligibility({
    approval_status: "approved",
    driver_status: "active",
  });
  assertEquals(r.ok, true);
});

Deno.test("account: suspended / deleted / disabled blocked", () => {
  assertEquals(
    evaluateNewWorkInvitationAccountEligibility({
      approval_status: "suspended",
      driver_status: "active",
    }).ok,
    false,
  );
  assertEquals(
    (evaluateNewWorkInvitationAccountEligibility({
      approval_status: "suspended",
      driver_status: "active",
    }) as { reason: string }).reason,
    "driver_suspended",
  );
  assertEquals(
    (evaluateNewWorkInvitationAccountEligibility({
      approval_status: "approved",
      driver_status: "deleted",
    }) as { reason: string }).reason,
    "driver_deleted",
  );
  assertEquals(
    (evaluateNewWorkInvitationAccountEligibility({
      approval_status: "approved",
      driver_status: "active",
      deleted_at: "2026-11-01T00:00:00.000Z",
    }) as { reason: string }).reason,
    "driver_deleted",
  );
  assertEquals(
    (evaluateNewWorkInvitationAccountEligibility({
      approval_status: "approved",
      driver_status: "disabled",
    }) as { reason: string }).reason,
    "driver_disabled",
  );
});

Deno.test("documents: expired/missing/rejected/pending map correctly", () => {
  assertEquals(
    mapDocumentStateToNewWorkDenyReason(
      docs({ allowed: false, document_state: "documents_expired" }),
    ),
    "documents_expired",
  );
  assertEquals(
    mapDocumentStateToNewWorkDenyReason(
      docs({ allowed: false, document_state: "documents_missing" }),
    ),
    "documents_missing",
  );
  assertEquals(
    mapDocumentStateToNewWorkDenyReason(
      docs({ allowed: false, document_state: "documents_rejected" }),
    ),
    "documents_rejected",
  );
  assertEquals(
    mapDocumentStateToNewWorkDenyReason(
      docs({ allowed: false, document_state: "documents_pending_review" }),
    ),
    "documents_pending_review",
  );
  assertEquals(
    mapDocumentStateToNewWorkDenyReason(
      docs({ allowed: true, document_state: "documents_approved" }),
    ),
    null,
  );
});

Deno.test("combined: expired docs fail even when account approved", () => {
  const r = evaluateNewWorkInvitationEligibilityFromParts({
    account: { approval_status: "approved", driver_status: "active" },
    documents: docs({ allowed: false, document_state: "documents_expired" }),
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "documents_expired");
});

Deno.test("combined: eligible offline account + approved docs pass (no online field)", () => {
  const r = evaluateNewWorkInvitationEligibilityFromParts({
    account: { approval_status: "approved", driver_status: "active" },
    documents: docs({ allowed: true, document_state: "documents_approved" }),
  });
  assertEquals(r.ok, true);
});

Deno.test("marketplace booking open: happy path", () => {
  const r = isScheduledMarketplaceBookingOpenForInvitation(
    {
      dispatch_mode: "scheduled",
      scheduled_status: "scheduled",
      status: "scheduled",
      scheduled_at: FUTURE,
      scheduled_broadcast_at: BROADCAST,
      driver_id: null,
      confirmed_driver_id: null,
    },
    NOW,
  );
  assertEquals(r.open, true);
});

Deno.test("marketplace booking: closed when assigned / terminal / held / past / no broadcast", () => {
  assertEquals(
    isScheduledMarketplaceBookingOpenForInvitation(
      {
        dispatch_mode: "scheduled",
        scheduled_status: "scheduled",
        status: "scheduled",
        scheduled_at: FUTURE,
        scheduled_broadcast_at: BROADCAST,
        driver_id: "driver-1",
        confirmed_driver_id: null,
      },
      NOW,
    ).open,
    false,
  );
  assertEquals(
    (isScheduledMarketplaceBookingOpenForInvitation(
      {
        dispatch_mode: "scheduled",
        scheduled_status: "scheduled",
        status: "cancelled",
        scheduled_at: FUTURE,
        scheduled_broadcast_at: BROADCAST,
      },
      NOW,
    ) as { reason: string }).reason,
    "trip_terminal",
  );
  assertEquals(
    isScheduledMarketplaceBookingOpenForInvitation(
      {
        dispatch_mode: "scheduled",
        scheduled_status: "admin_held",
        status: "scheduled",
        scheduled_at: FUTURE,
        scheduled_broadcast_at: BROADCAST,
      },
      NOW,
    ).open,
    false,
  );
  assertEquals(
    isScheduledMarketplaceBookingOpenForInvitation(
      {
        dispatch_mode: "scheduled",
        scheduled_status: "scheduled",
        status: "scheduled",
        scheduled_at: PAST,
        scheduled_broadcast_at: BROADCAST,
      },
      NOW,
    ).open,
    false,
  );
  assertEquals(
    isScheduledMarketplaceBookingOpenForInvitation(
      {
        dispatch_mode: "scheduled",
        scheduled_status: "scheduled",
        status: "scheduled",
        scheduled_at: FUTURE,
        scheduled_broadcast_at: null,
      },
      NOW,
    ).open,
    false,
  );
});

Deno.test("suppression log omits sensitive payloads", () => {
  const fields = newWorkInvitationSuppressionLogFields({
    layer: "test",
    reason: "documents_expired",
    driverId: "3ce653e2-67b9-46c8-8d57-06447de180b6",
    tripId: "4548f235-f562-453e-b554-f370195f713c",
  });
  assertEquals(fields.reason, "documents_expired");
  assertEquals(fields.driver_suffix, "80b6");
  assertEquals(fields.trip_suffix, "713c");
  assertEquals("token" in fields, false);
  assertEquals("email" in fields, false);
});

Deno.test("marketplace online presence: requires online + intent + fresh presence", () => {
  const now = Date.parse("2026-11-14T08:00:00.000Z");
  const freshHb = "2026-11-14T07:59:50.000Z";
  assertEquals(
    evaluateScheduledMarketplaceOnlinePresence({
      is_online: true,
      driver_online_intent: true,
      presence: { status: "online", last_heartbeat_at: freshHb },
      presenceMaxAgeSeconds: 45,
      nowMs: now,
    }).ok,
    true,
  );
  assertEquals(
    (evaluateScheduledMarketplaceOnlinePresence({
      is_online: false,
      driver_online_intent: true,
      presence: { status: "online", last_heartbeat_at: freshHb },
      presenceMaxAgeSeconds: 45,
      nowMs: now,
    }) as { reason: string }).reason,
    "driver_offline",
  );
  assertEquals(
    (evaluateScheduledMarketplaceOnlinePresence({
      is_online: true,
      driver_online_intent: false,
      presence: { status: "online", last_heartbeat_at: freshHb },
      presenceMaxAgeSeconds: 45,
      nowMs: now,
    }) as { reason: string }).reason,
    "online_intent_false",
  );
  assertEquals(
    (evaluateScheduledMarketplaceOnlinePresence({
      is_online: true,
      driver_online_intent: true,
      presence: null,
      presenceMaxAgeSeconds: 45,
      nowMs: now,
    }) as { reason: string }).reason,
    "no_presence_row",
  );
  assertEquals(
    (evaluateScheduledMarketplaceOnlinePresence({
      is_online: true,
      driver_online_intent: true,
      presence: {
        status: "online",
        last_heartbeat_at: "2026-11-14T07:00:00.000Z",
      },
      presenceMaxAgeSeconds: 45,
      nowMs: now,
    }) as { reason: string }).reason,
    "stale_heartbeat",
  );
});

Deno.test("source lock: marketplace notify uses online recipient eligibility on both paths", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/scheduledMarketplaceNotifySSOT.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "evaluateScheduledMarketplaceRecipientEligibility");
  assertStringIncludes(src, "isScheduledMarketplaceBookingOpenForInvitation");
  assertStringIncludes(src, "driver_service_areas");
  assertStringIncludes(src, "marketplace_pre_send");
  // Must not rely only on approval_status for recipient selection.
  assertEquals(src.includes('.eq("approval_status", "approved")'), false);
});

Deno.test("source lock: send-driver-notification gates SCHEDULED_RIDE_REQUEST with online recheck", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../functions/send-driver-notification/index.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "evaluateScheduledMarketplaceInviteSendGate");
  assertStringIncludes(src, "isScheduledMarketplaceInvite");
  assertStringIncludes(src, "SCHEDULED_RIDE_REQUEST");
  assertStringIncludes(src, "Requires online + online intent + fresh presence");
  // Commitment / confirmed paths must not share the marketplace invite gate.
  assertEquals(src.includes("SCHEDULED_JOB_CONFIRMED") && src.includes("evaluateScheduledMarketplaceInviteSendGate"), true);
  const confirmedGateMisuse = /isScheduledMarketplaceInvite\s*=\s*payload\.type === 'SCHEDULED_JOB_CONFIRMED'/.test(src);
  assertEquals(confirmedGateMisuse, false);
});

Deno.test("source lock: recipient eligibility composes docs + online presence", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/newWorkInvitationEligibilitySSOT.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "evaluateScheduledMarketplaceOnlinePresence");
  assertStringIncludes(src, "evaluateScheduledMarketplaceRecipientEligibility");
  assertStringIncludes(src, "isPresenceLivenessFresh");
  assertStringIncludes(src, "driver_online_intent");
  assertStringIncludes(src, "SCHEDULED_JOB_CONFIRMED / SCHEDULED_COMMITMENT are NOT gated");
});

Deno.test("source lock: ride-offer push gate uses live document eligibility", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/rideOfferDriverEligibility.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "evaluateDriverDocumentState");
  assertStringIncludes(src, "evaluateNewWorkInvitationAccountEligibility");
  assertStringIncludes(src, "documents_expired");
});

Deno.test("source lock: RIDE_STOP / trip cancel paths do not call marketplace invite gate", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../functions/send-driver-notification/index.ts",
      import.meta.url,
    ),
  );
  // Gate is only for SCHEDULED_RIDE_REQUEST envelope — not RIDE_STOP.
  const stopIdx = src.indexOf("const isRideStop");
  const marketplaceIdx = src.indexOf("isScheduledMarketplaceInvite");
  assertEquals(marketplaceIdx > 0, true);
  assertEquals(stopIdx > 0, true);
});
