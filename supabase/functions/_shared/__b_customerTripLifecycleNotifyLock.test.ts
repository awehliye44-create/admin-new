/**
 * Customer trip lifecycle notification lock.
 *
 * Canonical events + per-event Android channels + bundled iOS WAV +
 * authoritative token. Rematch must not send trip_cancelled.
 *
 * Run: deno test --allow-read supabase/functions/_shared/customerTripLifecycleNotifyLock.test.ts
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canonicalizeCustomerTripNotificationEvent,
  customerAndroidChannelIdForEvent,
  customerAndroidSoundForEvent,
  customerIosSoundFileForEvent,
} from "./customerTripLifecycleNotify.ts";

const read = async (rel: string) =>
  await Deno.readTextFile(new URL(rel, import.meta.url));

Deno.test("canonical aliases resolve to one registry key", () => {
  assertEquals(canonicalizeCustomerTripNotificationEvent("trip_accepted"), "driver_assigned");
  assertEquals(canonicalizeCustomerTripNotificationEvent("new_driver_assigned"), "driver_assigned");
  assertEquals(canonicalizeCustomerTripNotificationEvent("stacked_driver_assigned"), "driver_assigned");
  assertEquals(canonicalizeCustomerTripNotificationEvent("no_show"), "trip_cancelled");
  assertEquals(canonicalizeCustomerTripNotificationEvent("trip_cancelled"), "trip_cancelled");
});

Deno.test("per-event Android channels and bundled sounds", () => {
  assertEquals(customerAndroidChannelIdForEvent("driver_assigned"), "onecab_driver_assigned_v1");
  assertEquals(customerAndroidChannelIdForEvent("trip_completed"), "onecab_trip_completed_v1");
  assertEquals(customerAndroidChannelIdForEvent("trip_cancelled"), "onecab_trip_cancelled_v1");
  assertEquals(customerAndroidSoundForEvent("driver_assigned"), "driver_assigned");
  assertEquals(customerAndroidSoundForEvent("trip_completed"), "trip_completed");
  assertEquals(customerAndroidSoundForEvent("trip_cancelled"), "trip_cancelled");
  assertEquals(customerIosSoundFileForEvent("driver_assigned"), "driver_assigned.wav");
  assertEquals(customerIosSoundFileForEvent("trip_completed"), "trip_completed.wav");
  assertEquals(customerIosSoundFileForEvent("trip_cancelled"), "trip_cancelled.wav");
});

Deno.test("send-trip-notification uses WAV, per-event channels, authoritative token", async () => {
  const src = await read("../send-trip-notification/index.ts");
  assertStringIncludes(src, 'trip_cancelled:');
  assertStringIncludes(src, "resolveCustomerAuthoritativeToken");
  assertEquals(src.includes('sound: priority === \'high\' ? \'default\''), false);
  assertEquals(src.includes('sound: "default"'), false);
  assertEquals(src.includes("channel_id: 'trip_updates'"), false);
  assertEquals(src.includes("'critical_alerts'"), false);
  assertEquals(src.includes("'post_trip'"), false);
  assertStringIncludes(src, "customerAndroidChannelIdForEvent");
  assertStringIncludes(src, "customerIosSoundFileForEvent");
  assertStringIncludes(src, "customerIosCategoryIdForEvent");
  assertStringIncludes(src, "android_channel_id: channelId");
  assertEquals(src.includes("android: { notification: { channel_id: channelId"), false);
});

Deno.test("producers send after authoritative success; rematch does not cancel", async () => {
  const assign = await read("./rideAssignmentFinalize.ts");
  const accept = await read("../accept-offer/index.ts");
  const stop = await read("../stop-workflow/index.ts");
  const cancel = await read("../cancel-trip/index.ts");
  const driverCancel = await read("./driverTripCancel.ts");
  const adminCancel = await read("../admin-trip-actions/index.ts");
  const adminAction = await read("../admin-trip-action/index.ts");
  const expire = await read("../expire-trip/index.ts");
  const corporateCancel = await read("../cancel-corporate-trip/index.ts");
  const rematch = await read("../driver-cancel-before-pickup/index.ts");
  const autoDispatch = await read("../auto-dispatch/index.ts");
  const expireOffers = await read("../expire-offers/index.ts");
  const scheduledDispatch = await read("../scheduled-dispatch/index.ts");
  const getActiveTrip = await read("../get-active-trip/index.ts");
  const pickupNoShow = await read("../pickup-no-show/index.ts");
  const lateCancel = await read("../late-cancellation-check/index.ts");
  const helper = await read("./customerTripLifecycleNotify.ts");

  assertStringIncludes(assign, 'event: "driver_assigned"');
  // Listed-fare Accept (non-stacked) must notify — not only stacked / fare-final.
  assertStringIncludes(accept, 'event: "driver_assigned"');
  assertEquals(
    (accept.match(/event:\s*"driver_assigned"/g) ?? []).length >= 2,
    true,
  );
  assertStringIncludes(stop, 'event: "driver_arrived"');
  assertStringIncludes(stop, 'event: "trip_started"');
  assertStringIncludes(stop, 'event: "trip_completed"');
  assertStringIncludes(stop, "finalizeRideAssignmentSideEffects");
  assertStringIncludes(stop, "edge_stop_workflow_offer_claim");
  assertStringIncludes(cancel, 'event: "trip_cancelled"');
  assertStringIncludes(driverCancel, 'event: "trip_cancelled"');
  assertStringIncludes(adminCancel, 'event: "trip_cancelled"');
  assertStringIncludes(adminAction, 'event: "trip_completed"');
  assertStringIncludes(adminAction, 'event: "new_driver_assigned"');
  assertStringIncludes(adminAction, 'notify_driver_assigned');
  assertStringIncludes(adminAction, 'event: "driver_assigned"');
  const manualTrip = await Deno.readTextFile(
    new URL("../../../src/pages/ManualTrip.tsx", import.meta.url),
  );
  assertStringIncludes(manualTrip, "notify_driver_assigned");
  assertStringIncludes(manualTrip, "admin-trip-action");
  const scheduledUi = await Deno.readTextFile(
    new URL("../../../src/pages/ScheduledRides.tsx", import.meta.url),
  );
  assertStringIncludes(scheduledUi, "notify_driver_assigned");
  assertStringIncludes(expire, "expireTripWhenSearchExhaustedAndNotifyCustomer");
  assertStringIncludes(corporateCancel, "event: 'trip_cancelled'");
  const decline = await read("../decline-offer/index.ts");
  assertStringIncludes(decline, 'event: "trip_cancelled"');
  assertEquals(decline.includes("send-customer-notification"), false);
  assertEquals(rematch.includes('event: "trip_cancelled"'), false);
  assertStringIncludes(rematch, 'event: "driver_cancelled"');
  assertStringIncludes(rematch, "notifyCustomerTripLifecycle");

  // Direct expire_trip_when_search_exhausted RPC sites must notify via helper.
  assertStringIncludes(helper, "expireTripWhenSearchExhaustedAndNotifyCustomer");
  assertStringIncludes(helper, 'event: "trip_cancelled"');
  assertStringIncludes(autoDispatch, "expireTripWhenSearchExhaustedAndNotifyCustomer");
  assertEquals(autoDispatch.includes('rpc("expire_trip_when_search_exhausted"'), false);
  assertStringIncludes(autoDispatch, "finalizeRideAssignmentSideEffects");
  assertStringIncludes(autoDispatch, "edge_auto_dispatch_auto_accept");
  const acceptTrip = await read("../accept-trip/index.ts");
  assertStringIncludes(acceptTrip, "finalizeRideAssignmentSideEffects");
  assertStringIncludes(expireOffers, "expireTripWhenSearchExhaustedAndNotifyCustomer");
  assertEquals(expireOffers.includes('rpc("expire_trip_when_search_exhausted"'), false);
  assertStringIncludes(scheduledDispatch, "expireTripWhenSearchExhaustedAndNotifyCustomer");
  assertEquals(scheduledDispatch.includes('rpc("expire_trip_when_search_exhausted"'), false);
  assertStringIncludes(scheduledDispatch, "notifyCustomerNegotiationRematch");
  assertEquals(scheduledDispatch.includes('type: "DRIVER_UNAVAILABLE"'), false);
  assertEquals(scheduledDispatch.includes('type: "NO_DRIVER_AVAILABLE"'), false);
  assertEquals(scheduledDispatch.includes('type: "DRIVER_EN_ROUTE"'), false);
  const commitmentChunk = scheduledDispatch.slice(
    scheduledDispatch.indexOf("SCHEDULED_COMMITMENT_MODE_TRIGGERED"),
    scheduledDispatch.indexOf("committedCount++"),
  );
  assertStringIncludes(commitmentChunk, 'event: "driver_assigned"');
  assertStringIncludes(commitmentChunk, "notifyCustomerTripLifecycle");
  const adminNegCancel = await read("../admin-cancel-trip-negotiation/index.ts");
  assertStringIncludes(adminNegCancel, "notifyCustomerTripLifecycle");
  assertStringIncludes(adminNegCancel, 'event: "trip_cancelled"');
  assertStringIncludes(getActiveTrip, "expireTripWhenSearchExhaustedAndNotifyCustomer");
  assertEquals(getActiveTrip.includes('rpc("expire_trip_when_search_exhausted"'), false);
  assertStringIncludes(pickupNoShow, 'event: "no_show"');
  assertStringIncludes(pickupNoShow, "notifyCustomerTripLifecycle");
  assertStringIncludes(lateCancel, "notifyCustomerCancelledIfNeeded");
  assertStringIncludes(lateCancel, "notifyCustomerTripLifecycle");
  const sqlDispatch = await read("./dispatchOrchestrator.ts");
  assertStringIncludes(sqlDispatch, "notifyIfSqlDispatchExpiredTrip");
  assertStringIncludes(sqlDispatch, "notifyCustomerTripLifecycle");
  const stackedLifecycle = await read("./stackedRideLifecycle.ts");
  assertStringIncludes(stackedLifecycle, "notifyCustomerTripLifecycle");
  assertStringIncludes(stackedLifecycle, 'event: "trip_cancelled"');
  assertStringIncludes(stackedLifecycle, "notifyCustomerStackedTripPromoted");
  assertStringIncludes(stackedLifecycle, "driver_assigned-${tripId}-promoted");
  assertStringIncludes(stackedLifecycle, "cancelQueuedStackedTrip");
  const updateStop = await read("../update-stop-status/index.ts");
  assertStringIncludes(updateStop, 'event: "trip_completed"');
  assertStringIncludes(updateStop, 'event: "driver_arrived"');
  assertStringIncludes(updateStop, 'event: "trip_started"');
  assertStringIncludes(updateStop, "send-trip-notification");
  const negotiationRematch = await read("./negotiationFailureRematch.ts");
  assertStringIncludes(negotiationRematch, "notifyCustomerNegotiationRematch");
  assertStringIncludes(negotiationRematch, 'event: "finding_another_driver_updated_fare"');
  assertEquals(negotiationRematch.includes('event: "trip_cancelled"'), false);
  assertStringIncludes(expireOffers, "notifyCustomerNegotiationRematch");
  const driverFareFinal = await read("../driver-fare-final/index.ts");
  assertStringIncludes(driverFareFinal, "finalizeNegotiationFailureAndRebroadcast");
  // Finding-another push is centralized — not duplicated on DECLINE.
  assertEquals(driverFareFinal.includes('event: "finding_another_driver_updated_fare"'), false);
  const scheduledRide = await read("../scheduled-ride-action/index.ts");
  assertStringIncludes(scheduledRide, 'event: "driver_cancelled"');
  assertStringIncludes(scheduledRide, "notifyCustomerTripLifecycle");
  assertStringIncludes(scheduledRide, 'event: "driver_assigned"');
  assertEquals(scheduledRide.includes('type: "DRIVER_CONFIRMED"'), false);
  assertEquals(scheduledRide.includes('invoke("send-customer-notification"'), false);
  const cancelConfirmedChunk = scheduledRide.slice(
    scheduledRide.indexOf('action === "cancel_confirmed"'),
  );
  assertEquals(cancelConfirmedChunk.includes("send-customer-notification"), false);
  const scheduledCheckin = await read("../scheduled-checkin/index.ts");
  assertStringIncludes(scheduledCheckin, "notifyCustomerTripLifecycle");
  assertStringIncludes(scheduledCheckin, 'event: "driver_assigned"');
  assertEquals(scheduledCheckin.includes("send-customer-notification"), false);
  const sendCustomerNotif = await read("../send-customer-notification/index.ts");
  assertStringIncludes(sendCustomerNotif, "passengerId");
  assertStringIncludes(sendCustomerNotif, "resolveCustomerAuthoritativeToken");
  const lostProperty = await read("../lost-property/index.ts");
  assertStringIncludes(lostProperty, 'event: "driver_assigned"');
  assertStringIncludes(lostProperty, "notifyCustomerTripLifecycle");
  const lostPropertyTransition = await read("../lost-property-transition/index.ts");
  assertStringIncludes(lostPropertyTransition, "passenger_id: passengerId");
  assertStringIncludes(lostPropertyTransition, 'event: "driver_assigned"');
  assertStringIncludes(lostPropertyTransition, "notifyCustomerTripLifecycle");
});
