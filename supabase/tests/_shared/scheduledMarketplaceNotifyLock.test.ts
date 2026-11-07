/**
 * Make Available marketplace alert lock — MK-261103-006.
 * Run: deno test --allow-read supabase/tests/_shared/scheduledMarketplaceNotifyLock.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildScheduledMarketplacePushPayload,
  SCHEDULED_MARKETPLACE_NOTIFY_DRIVER_CAP,
} from "../../functions/_shared/scheduledMarketplaceNotifySSOT.ts";

Deno.test("marketplace push is list-only scheduled_ride_request (not NRO)", () => {
  const push = buildScheduledMarketplacePushPayload({
    id: "trip-1",
    pickup_address: "228 Upper Fifth Street",
    scheduled_at: "2026-11-03T15:20:00.000Z",
    trip_code: "MK-261103-006",
  });
  assertEquals(push.type, "SCHEDULED_RIDE_REQUEST");
  assertEquals(push.data.type, "scheduled_ride_request");
  assertEquals(push.data.open_scheduled_jobs, "true");
  assertEquals(push.data.trip_id, "trip-1");
  assertStringIncludes(push.body, "Scheduled Jobs");
  assert(!/new_ride_offer/i.test(JSON.stringify(push)));
});

Deno.test("fan-out cap is finite and positive", () => {
  assert(SCHEDULED_MARKETPLACE_NOTIFY_DRIVER_CAP > 0);
  assert(SCHEDULED_MARKETPLACE_NOTIFY_DRIVER_CAP <= 200);
});

Deno.test("source lock: Admin Make Available invokes marketplace notify", async () => {
  const admin = await Deno.readTextFile(
    new URL("../../../src/pages/ScheduledRides.tsx", import.meta.url),
  );
  assertStringIncludes(admin, "notify_marketplace_trip_id");
  assertStringIncludes(admin, "scheduled-dispatch");
});

Deno.test("source lock: scheduled-dispatch notifies on pending jobs + notify body", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/scheduled-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "notifyScheduledMarketplaceOpen");
  assertStringIncludes(src, "notify_marketplace_trip_id");
  assertStringIncludes(src, "SCHEDULED_MARKETPLACE_NOTIFY");
  assertStringIncludes(src, "pending_jobs_at");
  assertStringIncludes(src, "dispatch_mode, status");
});

Deno.test("source lock: marketplace notify applies new-work eligibility (MK0009)", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/scheduledMarketplaceNotifySSOT.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "evaluateDriverNewWorkInvitationEligibility");
  assertStringIncludes(src, "isScheduledMarketplaceBookingOpenForInvitation");
  assertEquals(src.includes('.eq("approval_status", "approved")'), false);
});

Deno.test("source lock: auto-dispatch allows scheduled broadcasting NRO", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/auto-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "scheduledBroadcastOpen");
  assertStringIncludes(src, 'sched === "broadcasting"');
  const blockAllScheduled = src.includes(
    "mode === \"scheduled\" ||\n        sched === \"admin_held\"",
  );
  assertEquals(blockAllScheduled, false);
});

Deno.test("source lock: Broadcast Now converts to instant live NRO", async () => {
  const ssot = await Deno.readTextFile(
    new URL("../../functions/_shared/scheduledAdminReleaseSSOT.ts", import.meta.url),
  );
  assertStringIncludes(ssot, "buildScheduledUrgentConversionPatch");
  assertStringIncludes(ssot, "converted_to_instant");
  assertEquals(ssot.includes('scheduled_status: "broadcasting"'), false);

  const admin = await Deno.readTextFile(
    new URL("../../../src/pages/ScheduledRides.tsx", import.meta.url),
  );
  assertStringIncludes(admin, "converted_to_instant");
  assertStringIncludes(admin, "dispatch_mode: 'instant'");
  assertStringIncludes(admin, "admin_broadcast_now");
});

Deno.test("source lock: send-driver-notification accepts SCHEDULED marketplace types", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/send-driver-notification/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "SCHEDULED_RIDE_REQUEST");
  assertStringIncludes(src, "SCHEDULED_JOB_CONFIRMED");
  assertStringIncludes(src, "SCHEDULED_COMMITMENT");
  const allowListMatch = src.match(
    /VALID_NOTIFICATION_TYPES\s*=\s*\[([\s\S]*?)\];/,
  );
  assert(allowListMatch, "VALID_NOTIFICATION_TYPES missing");
  const allowList = allowListMatch![1];
  assertStringIncludes(allowList, "SCHEDULED_RIDE_REQUEST");
  assertStringIncludes(allowList, "SCHEDULED_JOB_CONFIRMED");
  assertStringIncludes(allowList, "SCHEDULED_COMMITMENT");
});
