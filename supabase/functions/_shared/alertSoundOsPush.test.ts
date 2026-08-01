/**
 * Allowlisted OS push contract tests — Driver NRO + Customer 7 + shared safety.
 * Mirrors native alertEventRegistry contracts (no deploy).
 */
import {
  assertEquals,
  assertExists,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildFcmOsAlertBlocks,
  buildStableAlertIdentity,
  customerLifecycleOsPushSound,
  DRIVER_NEW_RIDE_OFFER_ANDROID_CHANNEL_ID,
  DRIVER_NEW_RIDE_OFFER_IOS_CATEGORY,
  DRIVER_NEW_RIDE_OFFER_IOS_SOUND,
  driverNewRideOfferOsPushSound,
  enforceAllowlistedOsSoundFields,
  isObsoleteCustomerChannelId,
  isRemoteOrPathSound,
  listCustomerOsPushContracts,
  resolveCustomerOsPush,
  resolveDriverRideOfferOsPush,
} from "./alertSoundOsPush.ts";
Deno.test("Driver NRO: APNs sound is onecab_new_ride_offer.wav (no CAF)", () => {
  const resolved = resolveDriverRideOfferOsPush("new_ride_offer");
  assertEquals(resolved.ok, true);
  if (!resolved.ok) return;
  assertEquals(resolved.contract.sound, "onecab_new_ride_offer.wav");
  assertEquals(resolved.contract.sound, DRIVER_NEW_RIDE_OFFER_IOS_SOUND);
  assertNotEquals(resolved.contract.sound, "ride_offer_alert.caf");
  assertEquals(DRIVER_NEW_RIDE_OFFER_IOS_SOUND.includes(".caf"), false);
});

Deno.test("Driver NRO: Android channel + iOS category + time-sensitive", () => {
  const ssot = driverNewRideOfferOsPushSound();
  assertEquals(ssot.channelId, "onecab_new_ride_offers_v1");
  assertEquals(ssot.channelId, DRIVER_NEW_RIDE_OFFER_ANDROID_CHANNEL_ID);
  assertEquals(ssot.category, "ONECAB_NEW_RIDE_OFFER");
  assertEquals(ssot.category, DRIVER_NEW_RIDE_OFFER_IOS_CATEGORY);
  assertEquals(ssot.interruptionLevel, "time-sensitive");
  assertEquals(ssot.adminEventKey, "new_ride_offer");
  assertEquals(ssot.canonicalKey, "NEW_RIDE_OFFER");
});

Deno.test("Driver stacked ride offer shares NRO OS contract", () => {
  const resolved = resolveDriverRideOfferOsPush("STACKED_RIDE_OFFER");
  assertEquals(resolved.ok, true);
  if (!resolved.ok) return;
  assertEquals(resolved.contract.adminEventKey, "stacked_ride_offer");
  assertEquals(resolved.contract.channelId, DRIVER_NEW_RIDE_OFFER_ANDROID_CHANNEL_ID);
  assertEquals(resolved.contract.sound, DRIVER_NEW_RIDE_OFFER_IOS_SOUND);
  assertEquals(resolved.contract.category, DRIVER_NEW_RIDE_OFFER_IOS_CATEGORY);
  assertEquals(resolved.contract.interruptionLevel, "time-sensitive");
});

Deno.test("Driver NRO: FCM/APNs blocks — alert push type, no Critical", () => {
  const ios = buildFcmOsAlertBlocks({
    platform: "ios",
    title: "New ride offer",
    body: "Tap to view",
    channelId: DRIVER_NEW_RIDE_OFFER_ANDROID_CHANNEL_ID,
    sound: DRIVER_NEW_RIDE_OFFER_IOS_SOUND,
    category: DRIVER_NEW_RIDE_OFFER_IOS_CATEGORY,
    interruptionLevel: "time-sensitive",
    priority: "HIGH",
  });
  assertExists(ios.apns);
  const headers = ios.apns!.headers as Record<string, string>;
  const aps = (ios.apns!.payload as { aps: Record<string, unknown> }).aps;
  assertEquals(headers["apns-push-type"], "alert");
  assertEquals(headers["apns-priority"], "10");
  assertEquals(aps.sound, "onecab_new_ride_offer.wav");
  assertEquals(aps.category, "ONECAB_NEW_RIDE_OFFER");
  assertEquals(aps["interruption-level"], "time-sensitive");
  assertEquals("critical" in aps, false);
  assertEquals(typeof aps.sound === "object", false);

  const android = buildFcmOsAlertBlocks({
    platform: "android",
    title: "New ride offer",
    body: "Tap to view",
    channelId: DRIVER_NEW_RIDE_OFFER_ANDROID_CHANNEL_ID,
    sound: DRIVER_NEW_RIDE_OFFER_IOS_SOUND,
    priority: "HIGH",
  });
  assertExists(android.android);
  const notif = (android.android as { notification: Record<string, unknown> }).notification;
  assertEquals(notif.channel_id, "onecab_new_ride_offers_v1");
  assertEquals(notif.sound, "onecab_new_ride_offer.wav");
});

Deno.test("Driver NRO: stable event_id + dedupe_key across retries", () => {
  const a = buildStableAlertIdentity({
    appRole: "driver",
    adminEventKey: "new_ride_offer",
    offerId: "offer-abc",
    tripId: "trip-1",
  });
  const b = buildStableAlertIdentity({
    appRole: "driver",
    adminEventKey: "new_ride_offer",
    offerId: "offer-abc",
    tripId: "trip-1",
  });
  assertEquals(a.event_id, b.event_id);
  assertEquals(a.dedupe_key, b.dedupe_key);
  assertEquals(a.event_type, "new_ride_offer");
  assertEquals(a.event_id, "offer-abc");
  assertEquals(a.dedupe_key, "driver:new_ride_offer:offer:offer-abc");
});

Deno.test("Driver unknown event fails safely", () => {
  const resolved = resolveDriverRideOfferOsPush("payment_received");
  assertEquals(resolved.ok, false);
  if (resolved.ok) return;
  assertEquals(resolved.code, "UNKNOWN_EVENT");
});

const CUSTOMER_SEVEN: Array<{
  key: string;
  sound: string;
  category: string;
  channel: string;
}> = [
  {
    key: "driver_assigned",
    sound: "driver_assigned.wav",
    category: "ONECAB_DRIVER_ASSIGNED",
    channel: "onecab_customer_updates_v1",
  },
  {
    key: "driver_arrived",
    sound: "driver_arrived.wav",
    category: "ONECAB_DRIVER_ARRIVED",
    channel: "onecab_customer_updates_v1",
  },
  {
    key: "trip_started",
    sound: "trip_started.wav",
    category: "ONECAB_TRIP_STARTED",
    channel: "onecab_customer_updates_v1",
  },
  {
    key: "trip_completed",
    sound: "trip_completed.wav",
    category: "ONECAB_TRIP_COMPLETED",
    channel: "onecab_customer_updates_v1",
  },
  {
    key: "trip_cancelled",
    sound: "trip_cancelled.wav",
    category: "ONECAB_TRIP_CANCELLED",
    channel: "onecab_customer_updates_v1",
  },
  {
    key: "message_received",
    sound: "message_received.wav",
    category: "ONECAB_MESSAGE_RECEIVED",
    channel: "onecab_customer_messages_v1",
  },
  {
    key: "general_notification",
    sound: "general_notification.wav",
    category: "ONECAB_GENERAL_NOTIFICATION",
    channel: "onecab_customer_general_v1",
  },
];

Deno.test("Customer 7 events: channel + APNs sound + category match native registry", () => {
  for (const row of CUSTOMER_SEVEN) {
    const resolved = resolveCustomerOsPush(row.key);
    assertEquals(resolved.ok, true, row.key);
    if (!resolved.ok) continue;
    assertEquals(resolved.contract.sound, row.sound, row.key);
    assertEquals(resolved.contract.category, row.category, row.key);
    assertEquals(resolved.contract.channelId, row.channel, row.key);
    assertEquals(isRemoteOrPathSound(resolved.contract.sound), false, row.key);
    assertEquals(isObsoleteCustomerChannelId(resolved.contract.channelId), false, row.key);

    const legacy = customerLifecycleOsPushSound(row.key);
    assertExists(legacy);
    assertEquals(legacy!.sound, row.sound);
    assertEquals(legacy!.channelId, row.channel);
  }
});

Deno.test("Customer payment_status reuses general_notification.wav per registry", () => {
  const resolved = resolveCustomerOsPush("PAYMENT_STATUS");
  assertEquals(resolved.ok, true);
  if (!resolved.ok) return;
  assertEquals(resolved.contract.sound, "general_notification.wav");
  assertEquals(resolved.contract.channelId, "onecab_customer_general_v1");
  assertEquals(resolved.contract.category, "ONECAB_GENERAL_NOTIFICATION");
});

Deno.test("Customer: no URL/path/channel-as-sound; obsolete channels rejected", () => {
  assertEquals(isRemoteOrPathSound("https://cdn.example/x.wav"), true);
  assertEquals(isRemoteOrPathSound("android/res/raw/driver_assigned"), true);
  assertEquals(isRemoteOrPathSound("driver_assigned.wav"), false);
  assertEquals(isObsoleteCustomerChannelId("onecab_customer_driver_assigned_v1"), true);
  assertEquals(isObsoleteCustomerChannelId("onecab_customer_updates_v1"), false);

  const contract = resolveCustomerOsPush("driver_assigned");
  assertEquals(contract.ok, true);
  if (!contract.ok) return;
  const enforced = enforceAllowlistedOsSoundFields(contract.contract, {
    channelId: "onecab_customer_driver_assigned_v1",
    sound: "https://storage.example/driver_assigned.wav",
  });
  assertEquals(enforced.channelId, "onecab_customer_updates_v1");
  assertEquals(enforced.sound, "driver_assigned.wav");
  assertEquals(enforced.rejectedRequestedChannel, true);
  assertEquals(enforced.rejectedRequestedSound, true);
});

Deno.test("Customer: ordinary events are never Critical; time-sensitive only when justified", () => {
  for (const row of CUSTOMER_SEVEN) {
    const resolved = resolveCustomerOsPush(row.key);
    assertEquals(resolved.ok, true);
    if (!resolved.ok) continue;
    const ios = buildFcmOsAlertBlocks({
      platform: "ios",
      title: "t",
      body: "b",
      channelId: resolved.contract.channelId,
      sound: resolved.contract.sound,
      category: resolved.contract.category,
      interruptionLevel: resolved.contract.interruptionLevel,
    });
    const aps = (ios.apns!.payload as { aps: Record<string, unknown> }).aps;
    const headers = ios.apns!.headers as Record<string, string>;
    assertEquals(headers["apns-push-type"], "alert");
    assertEquals("critical" in aps, false);
    if (resolved.contract.interruptionLevel === "time-sensitive") {
      assertEquals(aps["interruption-level"], "time-sensitive");
    } else {
      assertEquals("interruption-level" in aps, false);
    }
  }
});

Deno.test("Customer: stable identity across retries; unknown fails safely", () => {
  const a = buildStableAlertIdentity({
    appRole: "customer",
    adminEventKey: "driver_assigned",
    tripId: "trip-99",
    stateVersion: "3",
  });
  const b = buildStableAlertIdentity({
    appRole: "customer",
    adminEventKey: "driver_assigned",
    tripId: "trip-99",
    stateVersion: "3",
  });
  assertEquals(a, b);
  assertEquals(a.dedupe_key, "customer:driver_assigned:trip:trip-99:v:3");

  const unknown = resolveCustomerOsPush("not_a_real_event");
  assertEquals(unknown.ok, false);
  assertEquals(customerLifecycleOsPushSound("not_a_real_event"), null);
});

Deno.test("Shared: CAF override cannot pass through allowlist enforce", () => {
  const resolved = resolveDriverRideOfferOsPush("new_ride_offer");
  assertEquals(resolved.ok, true);
  if (!resolved.ok) return;
  const enforced = enforceAllowlistedOsSoundFields(resolved.contract, {
    sound: "ride_offer_alert.caf",
    channelId: "wrong_channel",
  });
  assertEquals(enforced.sound, "onecab_new_ride_offer.wav");
  assertEquals(enforced.channelId, "onecab_new_ride_offers_v1");
  assertEquals(enforced.rejectedRequestedSound, true);
  assertEquals(enforced.rejectedRequestedChannel, true);
});

Deno.test("Shared: remote sound stripped from FCM/APNs blocks", () => {
  const ios = buildFcmOsAlertBlocks({
    platform: "ios",
    title: "t",
    body: "b",
    channelId: "onecab_customer_updates_v1",
    sound: "https://evil.example/x.wav",
    category: "ONECAB_DRIVER_ASSIGNED",
  });
  const aps = (ios.apns!.payload as { aps: Record<string, unknown> }).aps;
  assertEquals("sound" in aps, false);

  const android = buildFcmOsAlertBlocks({
    platform: "android",
    title: "t",
    body: "b",
    channelId: "onecab_customer_updates_v1",
    sound: "https://evil.example/x.wav",
  });
  const notif = (android.android as { notification: Record<string, unknown> }).notification;
  assertEquals("sound" in notif, false);
});

Deno.test("Shared: customer allowlist does not invent obsolete per-event channels", () => {
  for (const c of listCustomerOsPushContracts()) {
    assertEquals(isObsoleteCustomerChannelId(c.channelId), false, c.adminEventKey);
    assertEquals(c.sound.endsWith(".wav"), true, c.adminEventKey);
    assertEquals(c.sound.includes("/"), false, c.adminEventKey);
  }
});
