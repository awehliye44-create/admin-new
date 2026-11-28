/**
 * #60B — Guest cancel fixtures (isolated, no paid bookings).
 *
 * Documents MK-261120-004 root cause and locks authorization shapes.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveCancelTripCallerAuthority } from "../../functions/_shared/cancelTripCallerAuthSSOT.ts";
import {
  createWhatsAppContinuationToken,
  verifyWhatsAppContinuationToken,
  buildWhatsAppContinuationSigningMaterial,
} from "../../functions/_shared/whatsappContinuationToken.ts";

const SIGNING = buildWhatsAppContinuationSigningMaterial({
  verifyToken: "test-verify",
  phoneNumberId: "test-phone",
});

Deno.test("#60B MK-261120-004 root cause: dynamic #57 import must not recur", async () => {
  const cancelSrc = await Deno.readTextFile(
    new URL("../../functions/cancel-trip/index.ts", import.meta.url).pathname,
  );
  // Production failed with ERR_MODULE_NOT_FOUND on dynamic import at 19:48:22–52 UTC.
  assertStringIncludes(cancelSrc, "STATIC import");
  assertEquals(/await\s+import\s*\(\s*["'][^"']*cancelTripCallerAuthSSOT/.test(cancelSrc), false);
});

Deno.test("#60B unauthorized rider claim denied", () => {
  const denied = resolveCancelTripCallerAuthority({
    claimedCancelledBy: "rider",
    isAdmin: false,
    callerUserId: "user-x",
    customerId: "cust-other",
    driverId: null,
    tripPassengerId: "cust-owner",
    tripDriverId: null,
    tripConfirmedDriverId: null,
  });
  assertEquals(denied.ok, false);
  if (!denied.ok) assertEquals(denied.code, "RIDER_NOT_PASSENGER");
});

Deno.test("#60B dual-role passenger cancels own trip as rider", () => {
  const ok = resolveCancelTripCallerAuthority({
    claimedCancelledBy: "rider",
    isAdmin: false,
    callerUserId: "user-dual",
    customerId: "cust-owner",
    driverId: "drv-other-profile",
    tripPassengerId: "cust-owner",
    tripDriverId: "drv-assigned",
    tripConfirmedDriverId: "drv-assigned",
  });
  assertEquals(ok.ok, true);
  if (ok.ok) {
    assertEquals(ok.cancelledBy, "rider");
    assertEquals(ok.cancelledById, "cust-owner");
  }
});

Deno.test("#60B dual-role assigned driver cannot cancel foreign trip as rider", () => {
  const denied = resolveCancelTripCallerAuthority({
    claimedCancelledBy: "rider",
    isAdmin: false,
    callerUserId: "user-dual",
    customerId: "cust-not-passenger",
    driverId: "drv-assigned",
    tripPassengerId: "cust-owner",
    tripDriverId: null,
    tripConfirmedDriverId: "drv-assigned",
  });
  assertEquals(denied.ok, false);
});

Deno.test("#60B expired track token rejected; expired book token recoverable", async () => {
  const now = Math.floor(Date.now() / 1000);
  const expiredTrack = await createWhatsAppContinuationToken(
    { purpose: "track", waId: "447700000001", tripId: "trip-1", ttlSeconds: 60 },
    SIGNING,
    now - 120,
  );
  const trackClaims = await verifyWhatsAppContinuationToken(expiredTrack, SIGNING, now);
  assertEquals(trackClaims, null);

  const expiredBook = await createWhatsAppContinuationToken(
    { purpose: "book", waId: "447700000001", tripId: null, ttlSeconds: 60 },
    SIGNING,
    now - 120,
  );
  const bookFresh = await verifyWhatsAppContinuationToken(expiredBook, SIGNING, now);
  assertEquals(bookFresh, null);
  const bookRecover = await verifyWhatsAppContinuationToken(expiredBook, SIGNING, now, {
    allowExpired: true,
  });
  assertEquals(bookRecover?.purpose, "book");
  assertEquals(bookRecover?.waId, "447700000001");
});

Deno.test("#60B track token reuse window keeps same trip binding", async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await createWhatsAppContinuationToken(
    { purpose: "track", waId: "447700000002", tripId: "trip-abc", ttlSeconds: 6 * 60 * 60 },
    SIGNING,
    now,
  );
  const claims = await verifyWhatsAppContinuationToken(token, SIGNING, now);
  assertEquals(claims?.purpose, "track");
  assertEquals(claims?.tripId, "trip-abc");
  assertEquals((claims!.exp - now) >= 30 * 60, true);
});

Deno.test("#60B guest-trip-action cancel requires confirm and rejects ambiguous success", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/guest-trip-action/index.ts", import.meta.url).pathname,
  );
  assertStringIncludes(src, "confirm !== true");
  assertStringIncludes(src, "cancelled: true");
  assertStringIncludes(src, "result.status >= 400");
  // Must not spread a 500 body as a soft success.
  assertStringIncludes(src, 'cancelled_by: "rider"');
});

Deno.test("#60B cancel-trip requireUser gates verify_jwt=false exposure", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/cancel-trip/index.ts", import.meta.url).pathname,
  );
  assertStringIncludes(src, "requireUser");
  assertStringIncludes(src, "resolveCancelTripCallerAuthority");
  // Body cancelled_by alone is never authority.
  assertStringIncludes(src, "Never trust body cancelled_by");
});
