/**
 * Marketplace Realtime Broadcast lock — invalidate-only, no passenger PII.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  SCHEDULED_MARKETPLACE_REALTIME_EVENT,
  buildScheduledMarketplaceRealtimePayload,
  scheduledMarketplaceRealtimeChannel,
} from "./scheduledMarketplaceRealtimeBroadcastSSOT.ts";

const root = new URL("../../../", import.meta.url);

Deno.test("marketplace realtime channel + event are stable", () => {
  assertEquals(
    scheduledMarketplaceRealtimeChannel("sa-mk"),
    "scheduled-marketplace:sa-mk",
  );
  assertEquals(SCHEDULED_MARKETPLACE_REALTIME_EVENT, "scheduled_marketplace_changed");
});

Deno.test("broadcast payload is invalidate-only (no passenger fields)", () => {
  const payload = buildScheduledMarketplaceRealtimePayload({
    tripId: "trip-1",
    serviceAreaId: "sa-1",
    reason: "published",
  });
  assertEquals(payload.trip_id, "trip-1");
  assertEquals(payload.service_area_id, "sa-1");
  assertEquals(payload.reason, "published");
  const keys = Object.keys(payload).sort();
  assertEquals(keys, ["reason", "service_area_id", "trip_id"]);
  assert(!JSON.stringify(payload).includes("passenger"));
  assert(!JSON.stringify(payload).includes("phone"));
  assert(!JSON.stringify(payload).includes("email"));
});

Deno.test("notify + accept/cancel wire marketplace broadcast", async () => {
  const notify = await Deno.readTextFile(
    new URL("supabase/functions/_shared/scheduledMarketplaceNotifySSOT.ts", root),
  );
  assertStringIncludes(notify, "broadcastScheduledMarketplaceChanged");
  assertStringIncludes(notify, 'reason: "published"');

  const action = await Deno.readTextFile(
    new URL("supabase/functions/scheduled-ride-action/index.ts", root),
  );
  assertStringIncludes(action, "broadcastScheduledMarketplaceChanged");
  assertStringIncludes(action, 'reason: "accepted"');
  assert(action.includes('reason: isCheckinOpen ? "converted" : "cancelled"'));
});
