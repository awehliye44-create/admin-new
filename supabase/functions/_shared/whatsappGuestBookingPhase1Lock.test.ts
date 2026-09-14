/**
 * Phase 1 lock: WhatsApp guest checkout uses create-trip-after-payment,
 * a token-derived phone, and Revolut redirect_url. No second trip writer.
 */

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildCreateRevolutOrderRequestBody } from "./revolutPreauthCustomerAttach.ts";
import {
  buildWhatsAppCheckoutRedirectUrl,
  buildWhatsAppGuestBookingSnapshot,
  phonesExactlyMatch,
  splitPassengerName,
} from "./whatsappGuestBookingSSOT.ts";
import { edgeFunctionInvokeHeaders } from "./edgeFunctionInvokeHeaders.ts";

Deno.test("Revolut order omits redirect_url unless the caller supplies one", () => {
  const without = buildCreateRevolutOrderRequestBody({
    amountMinor: 500,
    currency: "GBP",
    tripId: "trip",
    description: "app",
  });
  assertEquals("redirect_url" in without, false);

  const withUrl = buildCreateRevolutOrderRequestBody({
    amountMinor: 500,
    currency: "GBP",
    tripId: "trip",
    description: "whatsapp",
    redirectUrl: "https://onecab.net/whatsapp-track?wa=token",
  });
  assertEquals(withUrl.redirect_url, "https://onecab.net/whatsapp-track?wa=token");
});

Deno.test("WhatsApp redirect URL ignores non-https and localhost", () => {
  assertEquals(
    buildWhatsAppCheckoutRedirectUrl("https://onecab.net", "book-token"),
    "https://onecab.net/whatsapp-track?wa=book-token",
  );
  assertEquals(buildWhatsAppCheckoutRedirectUrl("http://onecab.net", "book-token"), null);
  assertEquals(buildWhatsAppCheckoutRedirectUrl("https://localhost", "book-token"), null);
  assertEquals(buildWhatsAppCheckoutRedirectUrl("https://127.0.0.1", "book-token"), null);
});

Deno.test("guest snapshot uses one name/phone pair from the WhatsApp identity", () => {
  const snap = buildWhatsAppGuestBookingSnapshot({
    serviceAreaId: "sa",
    vehicleTypeId: "vt",
    amountPence: 1099,
    currency: "GBP",
    paymentMethod: "card",
    pickupAddress: "A",
    pickupLat: 1,
    pickupLng: 2,
    dropoffAddress: "B",
    dropoffLat: 3,
    dropoffLng: 4,
    stops: [],
    estimatedDistanceKm: 2.5,
    estimatedDurationMin: 8,
    passengerName: "Ada Lovelace",
    passengerPhone: "+447700900123",
    customerId: "cust",
    clientActionId: "act",
    providerOrderId: "ord",
    continuationToken: "tok",
    waId: "447700900123",
    redirectUrl: "https://onecab.net/whatsapp-track?wa=tok",
  });
  assertEquals(snap.passenger_phone, "+447700900123");
  assertEquals(snap.customer_phone, snap.passenger_phone);
  assertEquals(snap.passenger_name, "Ada Lovelace");
  assertEquals(snap.customer_name, snap.passenger_name);
  assertEquals(snap.payment_intent_id, "ord");
  assertEquals(snap.when, "NOW");
  assertEquals(snap.estimated_fare, 10.99);
  assertEquals(phonesExactlyMatch("07700900123", "+447700900123"), false);
  assertEquals(phonesExactlyMatch("+447700900123", "447700900123"), true);
});

Deno.test("single-word names still satisfy customers first/last length checks", () => {
  const single = splitPassengerName("Ada");
  assertEquals(single.firstName.length >= 2, true);
  assertEquals(single.lastName.length >= 2, true);
  const two = splitPassengerName("Ada Lovelace");
  assertEquals(two, { firstName: "Ada", lastName: "Lovelace" });
});

Deno.test("WhatsApp finalize does not start a second dispatcher", async () => {
  const src = await Deno.readTextFile(
    new URL("./whatsappGuestBookingFinalize.ts", import.meta.url),
  );
  assertStringIncludes(src, "finalizeBookingAfterPaymentFromSession");
  assertEquals(src.includes("invokeAutoDispatch"), false);
  assertEquals(src.includes(".rpc("), false);
});

Deno.test("webhook routes WhatsApp sessions to create-trip-after-payment, not the SQL writer", async () => {
  const src = await Deno.readTextFile(
    new URL("../revolut-webhook/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "finalizeWhatsAppGuestBookingFromSession");
  assertStringIncludes(src, "isWhatsAppGuestBookingSession");
  const waBranch = src.indexOf("isWhatsAppGuestBookingSession(session)");
  const sqlCall = src.indexOf('supabase.rpc(\n            "finalize_paid_booking_session"');
  assertEquals(waBranch > 0 && sqlCall > waBranch, true);
  assertStringIncludes(src, "whatsappFinalizeNeedsRetry");
});

Deno.test("fare proxy does not send the service-role secret as a function bearer", async () => {
  const secret = edgeFunctionInvokeHeaders(new Request("https://onecab.net", {
    headers: { Authorization: "Bearer sb_secret_not_a_jwt", apikey: "sb_publishable_not_a_jwt" },
  }));
  assertEquals(secret, null);

  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2ln";
  const fromCaller = edgeFunctionInvokeHeaders(new Request("https://onecab.net", {
    headers: { Authorization: `Bearer ${jwt}`, apikey: "sb_publishable_not_a_jwt" },
  }));
  assertEquals(fromCaller?.Authorization, `Bearer ${jwt}`);
  assertEquals(fromCaller?.apikey, jwt);

  const fares = await Deno.readTextFile(
    new URL("../whatsapp-booking-fares/index.ts", import.meta.url),
  );
  assertStringIncludes(fares, "edgeFunctionInvokeHeaders");
  assertEquals(
    fares.includes('Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`'),
    false,
  );
});

Deno.test("guest payment intent does not trust a form phone and sets redirect_url", async () => {
  const src = await Deno.readTextFile(
    new URL("../create-guest-payment-intent/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "whatsAppWaIdToE164");
  assertStringIncludes(src, "redirectUrl");
  assertStringIncludes(src, "ensureWhatsAppGuestCustomer");
  assertStringIncludes(src, "reuseRegisteredPhoneOwner");
  assertStringIncludes(src, "PHONE_ALREADY_REGISTERED");
  assertStringIncludes(src, "auth_user_id_by_exact_phone");
  assertEquals(src.includes("phone.eq."), false);
  assertEquals(src.includes("customer_phone: customer_phone"), false);
  assertEquals(src.includes("finalize_paid_booking_session"), false);
  assertStringIncludes(src, "edgeFunctionInvokeHeaders");
  const cors = await Deno.readTextFile(new URL("./corsHeaders.ts", import.meta.url));
  assertStringIncludes(cors, "x-client-source");
  assertEquals(src.includes("apikey: serviceRoleKey"), false);
});

Deno.test("guest trip status resolves the booked session, not a phone suffix", async () => {
  const src = await Deno.readTextFile(
    new URL("../guest-trip-status/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "continuation_token");
  assertStringIncludes(src, "phonesExactlyMatch");
  assertEquals(src.includes("ilike(\"passenger_phone\""), false);
  assertEquals(src.includes("phonesLooselyMatch"), false);
  assertStringIncludes(src, "allowExpired: true");
  assertStringIncludes(src, 'stale?.purpose === "book"');
  assertStringIncludes(src, "trip_driver_live_location");
  assertStringIncludes(src, "latitude, longitude, heading, gps_recorded_at");
  assertEquals(src.includes("driver_live_locations"), false);
  assertEquals(src.includes("\"pickup_lat\""), false);
  assertEquals(src.includes("pickup_latitude"), true);
});

Deno.test("guest trip actions call existing modification and cancel functions only", async () => {
  const src = await Deno.readTextFile(
    new URL("../guest-trip-action/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "request-trip-modification");
  assertStringIncludes(src, "confirm-trip-modification-payment");
  assertStringIncludes(src, "cancel-trip");
  assertStringIncludes(src, "phonesExactlyMatch");
  assertEquals(src.includes("calculate-fare"), false);
  assertEquals(src.includes(".from(\"trips\").update"), false);
  assertEquals(src.includes(".from(\"trip_stops\").insert"), false);
  const workflow = await Deno.readTextFile(new URL("./whatsappWorkflow.ts", import.meta.url));
  assertEquals(workflow.includes("cancel-trip"), false);
  assertEquals(workflow.includes("request-trip-modification"), false);
});
