/**
 * #60 — Guest Web trip status must match Customer restore photo + tracking parity.
 * Source lock: never ship https-only photos or realtimeChannel: null again.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("..", import.meta.url).pathname;

Deno.test("#60 guest-trip-status signs driver photos like Customer restore", async () => {
  const src = await Deno.readTextFile(`${ROOT}/guest-trip-status/index.ts`);
  assertStringIncludes(src, "createSignedUrl");
  assertStringIncludes(src, "driver-documents");
  assertStringIncludes(src, 'document_type", "profile_photo"');
  assertStringIncludes(src, "resolveGuestRenderableDriverPhotoUrl");
  // Never regress to https-only passthrough as the sole photo path.
  assertEquals(src.includes('startsWith("https://")\n    ? driver.profile_photo_url'), false);
});

Deno.test("#60/#60B guest-trip-status stable track tokens + booking-scoped realtime session", async () => {
  const src = await Deno.readTextFile(`${ROOT}/guest-trip-status/index.ts`);
  assertStringIncludes(src, "reuseTrackToken");
  assertStringIncludes(src, "guest-trip-realtime-session");
  assertStringIncludes(src, "realtimeSession");
  // Must not advertise public trip:{id} as the Guest location channel.
  assertEquals(src.includes("realtimeChannel: `trip:${trip.id}`"), false);
});

Deno.test("#60B cancel-trip statically imports #57 SSOT (MK-261120-004)", async () => {
  const src = await Deno.readTextFile(`${ROOT}/cancel-trip/index.ts`);
  assertStringIncludes(
    src,
    'import { resolveCancelTripCallerAuthority } from "../_shared/cancelTripCallerAuthSSOT.ts"',
  );
  assertEquals(src.includes("await import(\n      \"../_shared/cancelTripCallerAuthSSOT.ts\""), false);
  assertEquals(src.includes('await import("../_shared/cancelTripCallerAuthSSOT.ts")'), false);
});

Deno.test("#60B guest-trip-realtime-session is booking-scoped (no anon location)", async () => {
  const src = await Deno.readTextFile(`${ROOT}/guest-trip-realtime-session/index.ts`);
  assertStringIncludes(src, "mintTripPassengerAccessToken");
  assertStringIncludes(src, "verifyWhatsAppContinuationToken");
  assertStringIncludes(src, "phonesExactlyMatch");
  assertStringIncludes(src, "customer-driver-loc:");
  assertStringIncludes(src, 'pollMode: "stale_fallback"');
});

Deno.test("#60 guest-trip-action cancel requires confirm and returns terminal trip", async () => {
  const src = await Deno.readTextFile(`${ROOT}/guest-trip-action/index.ts`);
  assertStringIncludes(src, 'action === "cancel_trip"');
  assertStringIncludes(src, "confirm !== true");
  assertStringIncludes(src, "cancelled: true");
  assertStringIncludes(src, 'cancelled_by: "rider"');
  assertStringIncludes(src, "invokeAsTripPassenger");
});

Deno.test("#60 passenger invoke supports phone-only guests without weakening #57", async () => {
  const src = await Deno.readTextFile(`${ROOT}/_shared/whatsappPassengerInvoke.ts`);
  assertStringIncludes(src, "whatsAppWaIdToE164");
  assertStringIncludes(src, "generateLink");
  assertStringIncludes(src, "verifyOtp");
  assertStringIncludes(src, "wa-guest-");
});

Deno.test("#60 continuation token still supports allowExpired book recovery", async () => {
  const src = await Deno.readTextFile(`${ROOT}/_shared/whatsappContinuationToken.ts`);
  assertStringIncludes(src, "allowExpired");
});
