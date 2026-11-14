/**
 * deno test --allow-read supabase/functions/_shared/customerLiveTripApns.test.ts
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("APNs liveactivity topic and push type contract are documented in SSOT", async () => {
  const src = await Deno.readTextFile(
    new URL("./customerLiveTripApns.ts", import.meta.url),
  );
  assertStringIncludes(src, 'push-type.liveactivity');
  assertStringIncludes(src, '"apns-push-type": "liveactivity"');
  assertStringIncludes(src, '"content-state"');
  assertStringIncludes(src, "stale-date");
  assertStringIncludes(src, "dismissal-date");
  assertStringIncludes(src, "com.onecab.customer.app");
  assertEquals(src.includes("apns-push-type\": \"alert\""), false);
});

Deno.test("publish edge fans out APNs + FCM without blocking mutations", async () => {
  const src = await Deno.readTextFile(
    new URL("../publish-customer-live-trip/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "sendCustomerLiveActivityApns");
  assertStringIncludes(src, 'type: "live_trip_update"');
  assertStringIncludes(src, "resolveCustomerAuthoritativeToken");
  assertStringIncludes(src, "Do not fail trip producers hard");
});
