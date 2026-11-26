/**
 * P6 H3 — Guest/WhatsApp tracking least privilege.
 * guest-trip-realtime-session is POLL-ONLY: a tracking link must never yield a
 * passenger Auth JWT. Only guest-trip-action (cancel/modify) may mint, and the
 * minted session is bound to role `customer`.
 * If these fail, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));
const realtime = await read("../../functions/guest-trip-realtime-session/index.ts");
const invoke = await read("../../functions/_shared/whatsappPassengerInvoke.ts");
const action = await read("../../functions/guest-trip-action/index.ts");

/** Strip comments so docs may mention the forbidden names. */
const code = realtime.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

Deno.test("realtime-session never mints or imports the passenger mint", () => {
  assertEquals(code.includes("mintTripPassengerAccessToken"), false);
  assertEquals(code.includes("whatsappPassengerInvoke"), false);
  assertEquals(code.includes("invokeAsTripPassenger"), false);
  assertEquals(code.includes("generateLink"), false);
  assertEquals(code.includes("verifyOtp"), false);
});

Deno.test("realtime-session returns no accessToken / expiresAtIso / channel names", () => {
  assertEquals(/accessToken/.test(code), false);
  assertEquals(/access_token/.test(code), false);
  assertEquals(/expiresAtIso/.test(code), false);
  assertEquals(/locationChannel|tripChannel/.test(code), false);
});

Deno.test("realtime-session returns the poll-only contract", () => {
  assertStringIncludes(code, 'pollMode: "required"');
  assertStringIncludes(code, "restorePollIntervalMs: RESTORE_POLL_MS");
  assertStringIncludes(code, "locationMaxStaleMs: LOCATION_MAX_STALE_MS");
  assertStringIncludes(code, "trackingTokenReuse: true");
  assertStringIncludes(code, "tripId: trip.id");
  assertStringIncludes(code, "driverId,");
  assertEquals(code.includes("stale_fallback"), false);
});

Deno.test("realtime-session still verifies tracking token + wa_id ownership", () => {
  assertStringIncludes(code, "verifyWhatsAppContinuationToken");
  assertStringIncludes(code, "phonesExactlyMatch");
  assertStringIncludes(code, "Not authorised for this trip");
  assertStringIncludes(code, "LIVE_TRACKABLE");
});

Deno.test("guest-trip-action cancel/modify still goes through the passenger invoke", () => {
  assertStringIncludes(action, "invokeAsTripPassenger");
  assertStringIncludes(action, "verifyWhatsAppContinuationToken");
});

Deno.test("mintTripPassengerAccessToken binds the minted session to role customer", () => {
  assertStringIncludes(invoke, "onecab_auth_session_roles");
  assertStringIncludes(invoke, 'access_role: "customer"');
  assertStringIncludes(invoke, 'onConflict: "session_id"');
  assertStringIncludes(invoke, "resolveAuthSessionIdFromClaims");
  // Bind happens before the token is returned.
  assert(invoke.indexOf("onecab_auth_session_roles") < invoke.indexOf("return { ok: true, userId, accessToken"));
  assertStringIncludes(invoke, "no mass-revoke API");
});
