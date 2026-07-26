import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildTokenDeactivatePatch,
  isApnsDeviceToken,
  isExpoPushToken,
  isFcmRegistrationToken,
  isInvalidProviderTokenError,
  parseDriverPushPlatform,
  tokenFingerprint,
} from "./driverPushToken.ts";

Deno.test("rejects Expo and raw APNs tokens", () => {
  assert(isExpoPushToken("ExponentPushToken[abc]"));
  assert(isApnsDeviceToken("a".repeat(64)));
  assertEquals(
    isFcmRegistrationToken("ExponentPushToken[abc]", "ios"),
    false,
  );
  assertEquals(isFcmRegistrationToken("a".repeat(64), "ios"), false);
});

Deno.test("accepts FCM-shaped tokens", () => {
  const android =
    "eMFjDRoYRLWN5KU7wL5w:APA91b" + "x".repeat(120);
  const iosLong = "cKPRmGOxTUOAsZSJccQS" + "y".repeat(80);
  assert(isFcmRegistrationToken(android, "android"));
  assert(isFcmRegistrationToken(iosLong, "ios"));
});

Deno.test("platform parse", () => {
  assertEquals(parseDriverPushPlatform("iOS"), "ios");
  assertEquals(parseDriverPushPlatform("web"), null);
});

Deno.test("invalid provider errors deactivate", () => {
  assert(
    isInvalidProviderTokenError({
      errCode: "UNREGISTERED",
    }),
  );
  assert(
    isInvalidProviderTokenError({
      errMessage: "BadDeviceToken",
    }),
  );
  assertEquals(
    isInvalidProviderTokenError({ errCode: "UNAVAILABLE" }),
    false,
  );
});

Deno.test("fingerprint never returns full token", () => {
  const token = "abcdefghijklmnopqrstuvwxyz0123456789";
  const fp = tokenFingerprint(token);
  assertEquals(fp.includes(token), false);
  assert(fp.includes("…"));
});

Deno.test("deactivate patch marks inactive", () => {
  const patch = buildTokenDeactivatePatch("UNREGISTERED");
  assertEquals(patch.is_active, false);
  assertEquals(patch.last_failure_reason, "UNREGISTERED");
});
