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
  assertEquals(
    selectLiveActivityPushToken({
      event: "end",
      pushToken: "pts-only",
      pushToStartToken: "pts-only",
    }),
    "pts-only",
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

Deno.test("ETA refresh exposes safe APNs probe without enabling fanout", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/refresh-customer-live-trip-etas/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "probe_apns");
  assertStringIncludes(src, "probeCustomerLiveActivityApnsCredentials");
  assertStringIncludes(src, "fanout_unchanged");
  assertStringIncludes(src, 'mode: "apns_probe"');
});
