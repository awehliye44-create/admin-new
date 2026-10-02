/**
 * send-customer-notification message shape on FCM HTTP v1.
 *
 * Field-for-field translation of the former legacy body
 * `{ to, priority: "high", notification: { title, body, sound: "default" },
 *    data: { type, ...data }, content_available (iOS) }`:
 * no Android channel override (the app default channel), OS default sound,
 * high priority, and content-available only on iOS tokens.
 */

const RAW_APNS_DEVICE_TOKEN = /^[a-fA-F0-9]{64}$/;

/** A raw APNs device token is not an FCM registration token — FCM v1 rejects it. */
export function isRawApnsDeviceToken(token: string): boolean {
  return RAW_APNS_DEVICE_TOKEN.test(token.trim());
}

export function buildCustomerNotificationFcmMessage(input: {
  token: string;
  platform: string | null | undefined;
  title: string;
  body: string;
  type?: string | null;
  data?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const data: Record<string, string> = { type: input.type || "trip_message" };
  for (const [key, value] of Object.entries(input.data ?? {})) {
    if (value === undefined || value === null) continue;
    data[key] = typeof value === "string" ? value : String(value);
  }

  const message: Record<string, unknown> = {
    token: input.token,
    notification: { title: input.title, body: input.body },
    data,
  };

  if (input.platform === "ios") {
    message.apns = {
      headers: { "apns-priority": "10", "apns-push-type": "alert" },
      payload: { aps: { sound: "default", "content-available": 1 } },
    };
  } else {
    message.android = {
      priority: "HIGH",
      notification: { sound: "default" },
    };
  }

  return message;
}
