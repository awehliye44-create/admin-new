/**
 * Exclusive scheduled activation + nearby fallback lock.
 * Run: deno test --allow-read supabase/tests/_shared/scheduledActivationExclusiveLock.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildExclusiveActivationOfferSnapshot,
  buildExclusiveActivationRideOfferPush,
  buildExclusiveFailureConversionPatch,
  mergeExcludedDriverIds,
  resolveActivationGrossPenceForPreview,
  resolveExclusiveActivationDriverNetPence,
  SCHEDULED_ACTIVATION_EXCLUSIVE_REASON,
} from "../../functions/_shared/scheduledActivationExclusiveSSOT.ts";

Deno.test("driver net never uses customer gross as the displayed net", () => {
  const trip = {
    estimated_total_pence: 5000,
    estimated_fare: 50,
    final_customer_fare_pence: 5000,
  };
  assertEquals(resolveExclusiveActivationDriverNetPence({ trip }), null);
  assertEquals(resolveActivationGrossPenceForPreview(trip), 5000);

  assertEquals(
    resolveExclusiveActivationDriverNetPence({
      trip: { ...trip, driver_net_pence: 4250 },
    }),
    4250,
  );
  assertEquals(
    resolveExclusiveActivationDriverNetPence({
      trip,
      computedPreviewPence: 4250,
    }),
    4250,
  );
});

Deno.test("exclusive push is RIDE_OFFER / NEW_RIDE_OFFER with offer_id + net + expiry", () => {
  const push = buildExclusiveActivationRideOfferPush({
    offerId: "offer-uuid-1",
    tripId: "trip-uuid-1",
    driverId: "driver-uuid-1",
    netPence: 4250,
    expiresAtIso: "2026-11-03T15:10:00.000Z",
    pickupAddress: "228 Upper Fifth Street",
    dropoffAddress: "Station",
    currencyCode: "GBP",
  });
  assertEquals(push.type, "RIDE_OFFER");
  assertEquals(push.data.type, "NEW_RIDE_OFFER");
  assertEquals(push.data.offer_id, "offer-uuid-1");
  assertEquals(push.data.trip_id, "trip-uuid-1");
  assertEquals(push.data.expires_at, "2026-11-03T15:10:00.000Z");
  assertEquals(push.data.driver_net_preview_pence, "4250");
  assertEquals(push.data.scheduled_status, "awaiting_activation_accept");
  assert(!/SCHEDULED_COMMITMENT/i.test(JSON.stringify(push)));
});

Deno.test("offer snapshot stamps net keys for SQL push body builder", () => {
  const snap = buildExclusiveActivationOfferSnapshot({
    trip: {
      scheduled_at: "2026-11-03T15:20:00.000Z",
      pickup_address: "A",
      dropoff_address: "B",
      currency_code: "GBP",
    },
    confirmedDriverId: "driver-1",
    netPence: 4100,
    kind: "local",
    expiresAtIso: "2026-11-03T15:12:00.000Z",
  });
  assertEquals(snap.scheduled_status, "awaiting_activation_accept");
  assertEquals(snap.driver_net_preview_pence, 4100);
  assertEquals(snap.driver_earnings_pence, 4100);
  assertEquals(snap.offered_driver_net_pence, 4100);
  assertEquals(snap.negotiation_disabled, true);
});

Deno.test("failure conversion excludes unsuccessful driver and flips to instant", () => {
  const patch = buildExclusiveFailureConversionPatch({
    nowIso: "2026-11-03T15:12:00.000Z",
    searchingExpiresAtIso: "2026-11-03T15:18:00.000Z",
    excludeDriverId: "driver-failed",
    existingExcludedDriverIds: ["driver-other"],
  });
  assertEquals(patch.dispatch_mode, "instant");
  assertEquals(patch.scheduled_status, "converted_to_instant");
  assertEquals(patch.confirmed_driver_id, null);
  assertEquals(patch.driver_id, null);
  assertEquals(
    (patch.excluded_driver_ids as string[]).sort(),
    ["driver-failed", "driver-other"].sort(),
  );
});

Deno.test("mergeExcludedDriverIds is idempotent", () => {
  assertEquals(
    mergeExcludedDriverIds(["a", "a"], "a").sort(),
    ["a"],
  );
  assertEquals(mergeExcludedDriverIds(null, "b"), ["b"]);
});

Deno.test("source lock: JIT runner arms exclusive/departure-ack without SCHEDULED_COMMITMENT", async () => {
  // Phase 4+ moved arm logic into runConfirmedJitActivationPass; cron only invokes it.
  const cron = await Deno.readTextFile(
    new URL("../../functions/scheduled-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(cron, "runConfirmedJitActivationPass");
  assertStringIncludes(cron, "SCHEDULED_ACTIVATION_EXCLUSIVE_REASON");
  assertStringIncludes(cron, "excludeDriverId");
  assertEquals(cron.includes('type: "SCHEDULED_COMMITMENT"'), false);

  const runner = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/runConfirmedJitActivationPass.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(runner, "resolveExclusiveActivationDriverNetPence");
  assertStringIncludes(runner, "evaluateConfirmedDriverExclusiveEligibility");
  assertStringIncludes(runner, "SCHEDULED_ACTIVATION_EXCLUSIVE_REASON");
  assertStringIncludes(runner, "ineligibleBypass");
  // Ride offer INSERT still drives NEW_RIDE_OFFER push (urgent audible).
  assertStringIncludes(runner, "ride_offers");
  assertEquals(runner.includes('type: "SCHEDULED_COMMITMENT"'), false);
});

Deno.test("source lock: decline-trip rescues exclusive activation immediately", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/decline-trip/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "rescueExclusiveActivationToNearby");
  assertStringIncludes(src, "awaiting_activation_accept");
  assertStringIncludes(src, "declinedImmediate");
  assertStringIncludes(src, "departureAckCancelled");
});

Deno.test("source lock: expire-offers rescues exclusive activation promptly", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/expire-offers/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "rescueExclusiveActivationToNearby");
  assertStringIncludes(src, "expiredImmediate");
  assertStringIncludes(src, "acknowledgementTimeout");
  assertStringIncludes(src, "awaiting_activation_accept");
  assertStringIncludes(src, "shouldRescueAwaitingActivation");
});

Deno.test("source lock: rescue kicks auto-dispatch with declined_driver_id", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/scheduledActivationExclusiveRescue.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "declined_driver_id");
  assertStringIncludes(src, "force_rebroadcast");
  assertStringIncludes(src, "excluded_driver_ids");
  assert(src.includes("cas_matched_0") || src.includes("already_converted"));
  assertStringIncludes(src, "triggerAutoDispatchWithRetry");
  assertStringIncludes(src, "SCHEDULED_ACTIVATION_DISPATCH_RETRY");
  assertStringIncludes(src, "SCHEDULED_ACTIVATION_DISPATCH_KICK_FAILED");
});

Deno.test("race: exclusive Accept and fallback rescue are mutually exclusive via CAS", async () => {
  const checkin = await Deno.readTextFile(
    new URL("../../functions/scheduled-checkin/index.ts", import.meta.url),
  );
  const rescue = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/scheduledActivationExclusiveRescue.ts",
      import.meta.url,
    ),
  );
  // Accept (start_journey) only commits while still awaiting_activation_accept.
  assertStringIncludes(checkin, 'eq("scheduled_status", "awaiting_activation_accept")');
  assertStringIncludes(checkin, 'status: "en_route_to_pickup"');
  assertStringIncludes(checkin, "activatedRows");
  // Rescue only converts while still in exclusive rescue statuses; 0-row CAS = loser.
  assertStringIncludes(rescue, "EXCLUSIVE_RESCUE_SCHEDULED_STATUSES");
  assertStringIncludes(rescue, "cas_matched_0");
  assertStringIncludes(rescue, "already_converted");
  // Converted trip must not remain awaiting_activation_accept (Accept cannot also win).
  assertStringIncludes(rescue, "buildExclusiveFailureConversionPatch");
  const ssot = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/scheduledActivationExclusiveSSOT.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(ssot, "buildScheduledUrgentConversionPatch");
  const urgent = await Deno.readTextFile(
    new URL("../../functions/_shared/scheduledDispatchConfig.ts", import.meta.url),
  );
  assertStringIncludes(urgent, 'scheduled_status: "converted_to_instant"');
});
