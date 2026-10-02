/**
 * Customer FCM HTTP v1 transport lock.
 *
 * send-customer-notification and send-trip-notification send through FCM HTTP v1
 * with GOOGLE_SERVICE_ACCOUNT_JSON (Firebase onecab26). The legacy server-key API
 * is retired and must never return. Driver transport is untouched.
 *
 * Run: deno test --allow-read supabase/tests/_shared/customerFcmHttpV1TransportLock.test.ts
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCustomerNotificationFcmMessage,
  isRawApnsDeviceToken,
} from "../../functions/_shared/customerNotificationPush.ts";
import { classifyFcmHttpV1Failure, fcmHttpV1SendUrl } from "../../functions/_shared/fcmHttpV1.ts";

const FUNCTIONS_ROOT = new URL("../../functions/", import.meta.url);
const read = (rel: string) => Deno.readTextFile(new URL(rel, FUNCTIONS_ROOT));

const FCM_TOKEN = `fcm${"b".repeat(40)}:${"c".repeat(100)}`;

async function* walkTs(dir: URL): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(dir)) {
    const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) yield* walkTs(child);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) yield child;
  }
}

Deno.test("send-customer-notification uses FCM HTTP v1 with the live service account", async () => {
  const src = await read("send-customer-notification/index.ts");
  assertStringIncludes(src, "readFcmServiceAccountJson");
  assertStringIncludes(src, "getFcmHttpV1AccessToken");
  assertStringIncludes(src, "sendFcmHttpV1Message");
  assertStringIncludes(src, "buildCustomerNotificationFcmMessage");
  assertEquals(src.includes("fcm/send"), false);
  assertEquals(src.includes("FCM_SERVER_KEY"), false);
  assertEquals(src.includes("key=${"), false);

  const helper = await read("_shared/fcmHttpV1.ts");
  assertStringIncludes(helper, 'Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON")');
  assertStringIncludes(helper, "https://www.googleapis.com/auth/firebase.messaging");
  assertStringIncludes(helper, "/messages:send");
  assertEquals(fcmHttpV1SendUrl("onecab26"), "https://fcm.googleapis.com/v1/projects/onecab26/messages:send");
});

Deno.test("no Edge Function sends through the retired legacy server-key API", async () => {
  const offenders: string[] = [];
  for await (const file of walkTs(FUNCTIONS_ROOT)) {
    const src = await Deno.readTextFile(file);
    if (src.includes("fcm.googleapis.com/fcm/send") || src.includes('Deno.env.get("FCM_SERVER_KEY")')) {
      offenders.push(file.pathname.split("/functions/")[1]);
    }
  }
  assertEquals(offenders, []);
});

Deno.test("FCM v1 helpers never log the service account or access token", async () => {
  const helper = await read("_shared/fcmHttpV1.ts");
  assertEquals(/console\.(log|warn|error|info)/.test(helper), false);
  const src = await read("send-customer-notification/index.ts");
  assertEquals(/console\.[a-z]+\([^)]*serviceAccountJson/.test(src), false);
  assertEquals(/console\.[a-z]+\([^)]*accessToken/.test(src), false);
});

Deno.test("customer notification payload keeps legacy semantics on v1 (Android)", () => {
  const msg = buildCustomerNotificationFcmMessage({
    token: FCM_TOKEN,
    platform: "android",
    title: "Lost property update",
    body: "Your item is ready",
    type: "lost_property_update",
    data: { tripId: "t-1", attempt: 2 as unknown as string },
  });
  assertEquals(msg.token, FCM_TOKEN);
  assertEquals(msg.notification, { title: "Lost property update", body: "Your item is ready" });
  assertEquals(msg.data, { type: "lost_property_update", tripId: "t-1", attempt: "2" });
  assertEquals(msg.android, { priority: "HIGH", notification: { sound: "default" } });
  assertEquals("apns" in msg, false);
  assertEquals("to" in msg, false);
});

Deno.test("customer notification payload keeps legacy semantics on v1 (iOS)", () => {
  const msg = buildCustomerNotificationFcmMessage({
    token: FCM_TOKEN,
    platform: "ios",
    title: "Thanks for the tip",
    body: "Your driver says thank you",
    data: { tripId: "t-2" },
  });
  assertEquals(msg.data, { type: "trip_message", tripId: "t-2" });
  assertEquals(msg.apns, {
    headers: { "apns-priority": "10", "apns-push-type": "alert" },
    payload: { aps: { sound: "default", "content-available": 1 } },
  });
  assertEquals("android" in msg, false);
});

Deno.test("caller data may override type exactly as the legacy spread did", () => {
  const msg = buildCustomerNotificationFcmMessage({
    token: FCM_TOKEN,
    platform: "android",
    title: "t",
    body: "b",
    type: "outer",
    data: { type: "inner" },
  });
  assertEquals((msg.data as Record<string, string>).type, "inner");
});

Deno.test("raw APNs device tokens are never sent to FCM", async () => {
  assert(isRawApnsDeviceToken("a".repeat(64)));
  assert(!isRawApnsDeviceToken(FCM_TOKEN));
  const src = await read("send-customer-notification/index.ts");
  const skip = src.indexOf("isRawApnsDeviceToken(token)");
  const send = src.indexOf("sendFcmHttpV1Message({");
  assert(skip > 0 && send > skip, "raw APNs guard must run before the FCM send");
});

Deno.test("only definitive FCM errors mark a token dead", () => {
  const body = (status: string, errorCode?: string) =>
    JSON.stringify({
      error: {
        status,
        details: errorCode
          ? [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode }]
          : [],
      },
    });
  assertEquals(classifyFcmHttpV1Failure(404, body("NOT_FOUND", "UNREGISTERED")).tokenDead, true);
  assertEquals(classifyFcmHttpV1Failure(404, body("NOT_FOUND", "UNREGISTERED")).errorCode, "UNREGISTERED");
  assertEquals(classifyFcmHttpV1Failure(410, "").tokenDead, true);
  assertEquals(classifyFcmHttpV1Failure(403, body("PERMISSION_DENIED", "SENDER_ID_MISMATCH")).tokenDead, false);
  assertEquals(classifyFcmHttpV1Failure(400, body("INVALID_ARGUMENT", "INVALID_ARGUMENT")).tokenDead, false);
  assertEquals(classifyFcmHttpV1Failure(401, body("UNAUTHENTICATED", "THIRD_PARTY_AUTH_ERROR")).tokenDead, false);
  assertEquals(classifyFcmHttpV1Failure(429, body("RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED")).tokenDead, false);
  assertEquals(classifyFcmHttpV1Failure(503, body("UNAVAILABLE", "UNAVAILABLE")).tokenDead, false);
  assertEquals(classifyFcmHttpV1Failure(500, "not json").errorCode, "HTTP_500");
});

Deno.test("send-customer-notification deletes only on definitive token death", async () => {
  const src = await read("send-customer-notification/index.ts");
  assertStringIncludes(src, "if (result.tokenDead) {");
  assertEquals((src.match(/\.from\("customer_push_tokens"\)\.delete\(\)/g) ?? []).length, 1);
});

Deno.test("Driver push transport is unchanged (own FCM v1 sender, live SA, push_tokens)", async () => {
  const driver = await read("send-driver-notification/index.ts");
  assertStringIncludes(driver, 'Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON")');
  assertStringIncludes(driver, "fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send");
  assertStringIncludes(driver, 'from("push_tokens")');
  assertEquals(driver.includes("fcmHttpV1"), false);
  assertEquals(driver.includes("customerNotificationPush"), false);
  assertEquals(driver.includes("fcm/send"), false);
});
