/**
 * Lock: WhatsApp no-driver / search-exhausted notification bridge.
 * Thin hook only — reuses expire/release SSOT; no second timeout.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const notify = await Deno.readTextFile(
  new URL("./whatsappNoDriverNotify.ts", import.meta.url),
);
const expire = await Deno.readTextFile(
  new URL("../expire-trip/index.ts", import.meta.url),
);
const sessionExpire = await Deno.readTextFile(
  new URL("../whatsapp-session-expire/index.ts", import.meta.url),
);

Deno.test("whatsapp no-driver message copy is locked", () => {
  assertStringIncludes(notify, "Sorry, no drivers are available for your journey right now.");
  assertStringIncludes(notify, "*ONECAB*");
});

Deno.test("whatsapp no-driver notify is idempotent via no_driver_customer_alert_sent_at", () => {
  assertStringIncludes(notify, "no_driver_customer_alert_sent_at");
  assertStringIncludes(notify, '.is("no_driver_customer_alert_sent_at", null)');
});

Deno.test("whatsapp no-driver only for whatsapp booking sources", () => {
  assertStringIncludes(notify, "whatsapp_booking");
  assertStringIncludes(notify, "isWhatsAppBookingSource");
});

Deno.test("whatsapp no-driver resets workflow to idle", () => {
  assertStringIncludes(notify, 'workflow_state: "idle"');
  assertStringIncludes(notify, "booking_session_expires_at: null");
});

Deno.test("expire-trip calls WhatsApp no-driver notify after successful expire", () => {
  assertStringIncludes(expire, "notifyWhatsAppNoDriverForTrip");
  assertStringIncludes(expire, "releaseRevolutPreauthForTrip");
  assertStringIncludes(expire, 'reason: "no_driver_assigned"');
});

Deno.test("whatsapp-session-expire consumes searching_expires_at (no second timeout)", () => {
  assertStringIncludes(sessionExpire, "searching_expires_at");
  assertStringIncludes(sessionExpire, "expire_trip_when_search_exhausted");
  assertStringIncludes(sessionExpire, "notifyWhatsAppNoDriverForTrip");
  assertEquals(sessionExpire.includes("BOOKING_SESSION_TTL"), false);
});

Deno.test("whatsapp-session-expire recovers null-expiry stuck book rows", () => {
  assertStringIncludes(sessionExpire, "stuck_book");
  assertStringIncludes(sessionExpire, '.is("booking_session_expires_at", null)');
});
