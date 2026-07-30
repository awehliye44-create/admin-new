/**
 * SSOT OS push sound / channel IDs for Driver + Customer native installs.
 * Keep in sync with:
 * - onecab-driver-native NEW_RIDE_OFFERS_CHANNEL_ID / IOS_NEW_RIDE_OFFER_SOUND_FILE
 * - onecab-customer-native androidChannelIdForEvent / iosSoundFileNameForEvent
 */

export const DRIVER_NEW_RIDE_OFFER_ANDROID_CHANNEL_ID = "onecab_new_ride_offers_v1";
export const DRIVER_NEW_RIDE_OFFER_IOS_SOUND = "onecab_new_ride_offer.wav";

export function customerAndroidChannelIdForEvent(eventKey: string): string {
  return `onecab_customer_${eventKey}_v1`;
}

export function customerIosSoundFileNameForEvent(eventKey: string): string {
  return `${eventKey.replace(/[^a-zA-Z0-9._-]+/g, "_")}.wav`;
}

export type OsPushSoundFields = {
  channelId: string;
  sound: string;
};

export function driverNewRideOfferOsPushSound(): OsPushSoundFields {
  return {
    channelId: DRIVER_NEW_RIDE_OFFER_ANDROID_CHANNEL_ID,
    sound: DRIVER_NEW_RIDE_OFFER_IOS_SOUND,
  };
}

export function customerLifecycleOsPushSound(eventKey: string): OsPushSoundFields {
  return {
    channelId: customerAndroidChannelIdForEvent(eventKey),
    sound: customerIosSoundFileNameForEvent(eventKey),
  };
}

/** Build FCM android + APNs blocks that reference installed SSOT assets. */
export function buildFcmOsAlertBlocks(args: {
  platform: "android" | "ios" | string;
  title: string;
  body: string;
  channelId: string;
  sound: string;
  threadId?: string;
  category?: string;
  priority?: "HIGH" | "NORMAL";
}): { android?: Record<string, unknown>; apns?: Record<string, unknown> } {
  if (args.platform === "android") {
    return {
      android: {
        priority: args.priority ?? "HIGH",
        notification: {
          channel_id: args.channelId,
          sound: args.sound,
          title: args.title,
          body: args.body,
        },
      },
    };
  }
  if (args.platform === "ios") {
    return {
      apns: {
        headers: {
          "apns-priority": args.priority === "NORMAL" ? "5" : "10",
          "apns-push-type": "alert",
        },
        payload: {
          aps: {
            alert: { title: args.title, body: args.body },
            sound: args.sound,
            ...(args.category ? { category: args.category } : {}),
            ...(args.threadId ? { "thread-id": args.threadId } : {}),
          },
        },
      },
    };
  }
  return {};
}
