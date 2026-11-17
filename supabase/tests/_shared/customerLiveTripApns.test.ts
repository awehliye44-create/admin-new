/**
 * deno test --allow-read supabase/functions/_shared/customerLiveTripApns.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { selectLiveActivityPushToken } from "../../functions/_shared/customerLiveTripApns.ts";

Deno.test("APNs liveactivity topic and push type contract are documented in SSOT", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/customerLiveTripApns.ts", import.meta.url),
  );
  assertStringIncludes(src, "push-type.liveactivity");
  assertStringIncludes(src, '"apns-push-type": "liveactivity"');
  assertStringIncludes(src, '"content-state"');
  assertStringIncludes(src, "stale-date");
  assertStringIncludes(src, "dismissal-date");
  assertStringIncludes(src, "attributes-type");
  assertStringIncludes(src, "OneCabLiveTripAttributes");
  assertStringIncludes(src, "com.onecab.customer.app");
  assertStringIncludes(src, "api.sandbox.push.apple.com");
  assertStringIncludes(src, "api.push.apple.com");
  assertStringIncludes(src, "probeCustomerLiveActivityApnsCredentials");
  assertStringIncludes(src, "selectLiveActivityPushToken");
  assertEquals(src.includes('apns-push-type": "alert"'), false);
});

Deno.test("selectLiveActivityPushToken prefers push-to-start for start events", () => {
  assertEquals(
    selectLiveActivityPushToken({
      event: "start",
      pushToken: "activity-token",
      pushToStartToken: "pts-token",
    }),
    "pts-token",
  );
  assertEquals(
    selectLiveActivityPushToken({
      event: "update",
      pushToken: "activity-token",
      pushToStartToken: "pts-token",
    }),
    "activity-token",
  );
  assertEquals(
    selectLiveActivityPushToken({
      event: "start",
      pushToken: "pts-only",
      pushToStartToken: "pts-only",
    }),
    "pts-only",
  );
  // MK-261116-015: mirrored PTS must not be used for update/end.
  assertEquals(
    selectLiveActivityPushToken({
      event: "update",
      pushToken: "pts-only",
      pushToStartToken: "pts-only",
    }),
    null,
  );
  assertEquals(
    selectLiveActivityPushToken({
      event: "end",
      pushToken: "",
      pushToStartToken: "pts-only",
    }),
    null,
  );
  assertEquals(
    selectLiveActivityPushToken({
      event: "update",
      pushToken: "",
      pushToStartToken: "pts-only",
    }),
    null,
  );
});

Deno.test("publish edge fans out APNs + FCM without blocking mutations", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/publish-customer-live-trip/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "sendCustomerLiveActivityApns");
  assertStringIncludes(src, "selectLiveActivityPushToken");
  assertStringIncludes(src, "push_to_start_token");
  assertStringIncludes(src, 'type: "live_trip_update"');
  assertStringIncludes(src, "resolveCustomerAuthoritativeToken");
  assertStringIncludes(src, "Do not fail trip producers hard");
});

Deno.test("register ActivityKit token never selects missing server_device_id (MK-261116-013)", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../functions/register-customer-live-activity-token/index.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, '.from("customer_active_devices")');
  assertStringIncludes(src, '.select("device_id")');
  assertEquals(src.includes("server_device_id"), false);
  assertStringIncludes(src, 'onConflict: "customer_user_id,device_id"');
  // MK-261117-006: identical PTS/activity must always strip push_token.
  assertStringIncludes(src, "stripping identical activity/PTS token");
  assertStringIncludes(src, "MK-261117-006");
  assertEquals(
    src.includes("resolvedPushToken === resolvedPushToStart &&\n      !pushToken"),
    false,
  );
});

Deno.test("ETA refresh exposes safe APNs probe without enabling fanout", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/refresh-customer-live-trip-etas/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "probe_apns");
  assertStringIncludes(src, "probeCustomerLiveActivityApnsCredentials");
  assertStringIncludes(src, "fanout_unchanged");
  assertStringIncludes(src, 'mode: "apns_probe"');
});
