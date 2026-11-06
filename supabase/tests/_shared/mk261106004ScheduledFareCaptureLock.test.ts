/**
 * MK-261106-004 — scheduled fare capture lock.
 *
 * Read-only incident facts (production audit, no mutation):
 * - Trip: MK-261106-004 / be307ace-123c-4c76-9f74-778d58db75ef
 * - Created: 2026-11-06 09:02:28 UTC
 * - Pickup: 2026-11-07 02:45:00 UTC (02:45 Europe/London)
 * - Fare: 611p (£6.11) CARD / Revolut 6aed979c-…
 * - Session e68d2166-… AUTHORISED / trip_created; captured_amount null
 * - Webhooks: ORDER_PAYMENT_AUTHENTICATED, ORDER_AUTHORISED only
 * - Verdict: authorised hold only — NOT captured
 *
 * Run:
 *   deno test --allow-read supabase/tests/_shared/mk261106004ScheduledFareCaptureLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertFareCaptureAllowedAtProvider,
  isTerminalFeeCaptureTripStatus,
  isTripCompletedForFareCapture,
  shouldMirrorRideBookingProviderCapture,
} from "../../functions/_shared/scheduledFareCaptureGateSSOT.ts";

const ROOT = new URL("../../functions/", import.meta.url);

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, ROOT));
}

Deno.test("gate: fare capture only when completed", () => {
  assertEquals(
    assertFareCaptureAllowedAtProvider({ tripStatus: "scheduled", captureKind: "fare" }).ok,
    false,
  );
  assertEquals(
    assertFareCaptureAllowedAtProvider({ tripStatus: "en_route", captureKind: "fare" }).ok,
    false,
  );
  assertEquals(
    assertFareCaptureAllowedAtProvider({ tripStatus: "in_progress", captureKind: "fare" }).ok,
    false,
  );
  assertEquals(
    assertFareCaptureAllowedAtProvider({ tripStatus: "arrived", captureKind: "fare" }).ok,
    false,
  );
  const ok = assertFareCaptureAllowedAtProvider({
    tripStatus: "completed",
    captureKind: "fare",
  });
  assertEquals(ok.ok, true);
});

Deno.test("gate: book well ahead / cross-midnight scheduled still blocks fare capture", () => {
  // MK-261106-004 class: booked 6 Nov, pickup 7 Nov 02:45 London — still scheduled.
  const ahead = assertFareCaptureAllowedAtProvider({
    tripStatus: "scheduled",
    captureKind: "fare",
  });
  assertEquals(ahead.ok, false);
  if (!ahead.ok) {
    assertEquals(ahead.code, "FARE_CAPTURE_BEFORE_COMPLETION");
  }
});

Deno.test("gate: accept / arrive / start still £0 fare capture", () => {
  for (const status of ["accepted", "confirmed", "arrived", "started", "in_progress"]) {
    const r = assertFareCaptureAllowedAtProvider({ tripStatus: status, captureKind: "fare" });
    assertEquals(r.ok, false, status);
  }
});

Deno.test("gate: completion allows fare capture once", () => {
  assertEquals(isTripCompletedForFareCapture("completed"), true);
  assertEquals(
    assertFareCaptureAllowedAtProvider({ tripStatus: "completed", captureKind: "fare" }).ok,
    true,
  );
});

Deno.test("gate: terminal fee capture allowed; rematch cancel statuses fee-gated", () => {
  assertEquals(isTerminalFeeCaptureTripStatus("cancelled"), true);
  assertEquals(isTerminalFeeCaptureTripStatus("no_show"), true);
  assertEquals(
    assertFareCaptureAllowedAtProvider({
      tripStatus: "cancelled",
      captureKind: "terminal_fee",
    }).ok,
    true,
  );
  // No-fee rematch cancel still uses terminal_fee kind only when fee>0 path runs;
  // fare capture remains blocked on cancelled.
  assertEquals(
    assertFareCaptureAllowedAtProvider({
      tripStatus: "cancelled",
      captureKind: "fare",
    }).ok,
    false,
  );
  assertEquals(
    assertFareCaptureAllowedAtProvider({
      tripStatus: "scheduled",
      captureKind: "terminal_fee",
    }).ok,
    false,
  );
});

Deno.test("mirror: COMPLETED webhook must not stamp capture while scheduled", () => {
  assertEquals(
    shouldMirrorRideBookingProviderCapture({
      tripStatus: "scheduled",
      purpose: "RIDE_BOOKING",
    }),
    false,
  );
  assertEquals(
    shouldMirrorRideBookingProviderCapture({
      tripStatus: "completed",
      purpose: "RIDE_BOOKING",
    }),
    true,
  );
  assertEquals(
    shouldMirrorRideBookingProviderCapture({
      tripStatus: "cancelled",
      purpose: "RIDE_BOOKING",
    }),
    true,
  );
});

Deno.test("source lock: completion/admin capture call shared fare gate before provider", async () => {
  const completion = await read("_shared/revolutCompletionCapture.ts");
  const admin = await read("_shared/adminCaptureTripPaymentSSOT.ts");
  assertStringIncludes(completion, "assertFareCaptureAllowedAtProvider");
  assertStringIncludes(completion, 'captureKind: "fare"');
  assertStringIncludes(admin, "assertFareCaptureAllowedAtProvider");
  assertStringIncludes(admin, 'captureKind: "fare"');
  const gate = await read("_shared/scheduledFareCaptureGateSSOT.ts");
  assertStringIncludes(gate, "Cannot capture Revolut hold before trip is completed");
  // Completion returns gate.error (trip_not_completed) rather than a local hardcode.
  assertStringIncludes(completion, "trip_not_completed");
});

Deno.test("source lock: fee paths use terminal_fee kind", async () => {
  const release = await read("_shared/revolutPreauthReleaseSSOT.ts");
  const dispose = await read("_shared/terminalTripPaymentDisposition.ts");
  assertStringIncludes(release, 'captureKind: "terminal_fee"');
  assertStringIncludes(dispose, 'captureKind: "terminal_fee"');
});

Deno.test("source lock: webhook refuses premature capture mirror", async () => {
  const webhook = await read("revolut-webhook/index.ts");
  assertStringIncludes(webhook, "shouldMirrorRideBookingProviderCapture");
  assertStringIncludes(webhook, "refusing local capture mirror before trip completed");
  assertStringIncludes(webhook, "skip trip payment_status=captured before completion");
  assertStringIncludes(webhook, "capture_before_trip_completion");
  assertStringIncludes(webhook, "handleRevolutPaymentInvariantViolation");
  assertStringIncludes(webhook, "cancelTripForLostPaymentAuthorisation");
});

Deno.test("source lock: scheduled-dispatch / convert never request capture", async () => {
  const dispatch = await read("scheduled-dispatch/index.ts");
  assertEquals(dispatch.includes("captureRevolutOrder"), false);
  assertEquals(dispatch.includes("invokeFinalizeTripCapture"), false);
  assertEquals(dispatch.includes("finalizeRevolutTripCapture"), false);
  assertStringIncludes(dispatch, "assertPaymentGate");

  let convert = "";
  try {
    convert = await Deno.readTextFile(
      new URL("../../functions/_shared/scheduleDispatchConversionSweep.ts", import.meta.url),
    );
  } catch {
    convert = "";
  }
  if (convert) {
    assertEquals(convert.includes("captureRevolutOrder"), false);
    assertEquals(convert.includes("invokeFinalizeTripCapture"), false);
  }
});

Deno.test("duplicate COMPLETED / finalize still require completed gate (idempotent refuse)", () => {
  // Two evaluations while still scheduled → both refuse (no capture).
  const a = assertFareCaptureAllowedAtProvider({
    tripStatus: "scheduled",
    captureKind: "fare",
  });
  const b = assertFareCaptureAllowedAtProvider({
    tripStatus: "scheduled",
    captureKind: "fare",
  });
  assertEquals(a.ok, false);
  assertEquals(b.ok, false);
  // After completion, gate opens (exactly-once capture is ownership/idempotency elsewhere).
  assertEquals(
    assertFareCaptureAllowedAtProvider({ tripStatus: "completed", captureKind: "fare" }).ok,
    true,
  );
});

Deno.test("channel lock: booking channels authorise only — never call captureRevolutOrder", async () => {
  // Customer iOS/Android + web/guest + WhatsApp + corporate + integrations book via these
  // Edge entrypoints. Fare collection must stay at completion (shared gate), not booking.
  const bookingEntrypoints = [
    "create-preauth-payment-intent/index.ts",
    "create-trip-after-payment/index.ts",
    "create-trip/index.ts",
    "create-trip-request/index.ts",
    "create-guest-payment-intent/index.ts",
    "create-corporate-book/index.ts",
    "finalize-paid-booking-session/index.ts",
    "whatsapp-webhook/index.ts",
    "whatsapp-reply/index.ts",
    "booking-received/index.ts",
  ];
  for (const rel of bookingEntrypoints) {
    const src = await read(rel);
    assertEquals(src.includes("captureRevolutOrder"), false, rel);
    assertEquals(src.includes("invokeFinalizeTripCapture"), false, rel);
    assertEquals(src.includes("finalizeRevolutTripCapture"), false, rel);
  }
});

Deno.test("channel lock: every fare-collect path reaches shared gate before provider", async () => {
  // Customer Driver complete → stop-workflow → finalize-trip-and-capture → completion SSOT
  const finalize = await read("finalize-trip-and-capture/index.ts");
  assertStringIncludes(finalize, "finalizeRevolutTripCapture");
  assertEquals(finalize.includes("captureRevolutOrder"), false);

  const stop = await read("stop-workflow/index.ts");
  assertStringIncludes(stop, "invokeFinalizeTripCapture");
  assertEquals(stop.includes("captureRevolutOrder"), false);

  // Admin/manual capture
  const adminCapture = await read("admin-capture-trip-payment/index.ts");
  assertStringIncludes(adminCapture, "executeAdminCaptureTripPayment");
  assertEquals(adminCapture.includes("captureRevolutOrder"), false);

  const remediate = await read("admin-remediate-trip-payment/index.ts");
  assertStringIncludes(remediate, "finalizeRevolutTripCapture");
  assertEquals(remediate.includes("captureRevolutOrder"), false);

  // Shared modules: only fare/fee call sites may invoke provider capture, and both are gated.
  const completion = await read("_shared/revolutCompletionCapture.ts");
  const adminSsot = await read("_shared/adminCaptureTripPaymentSSOT.ts");
  const release = await read("_shared/revolutPreauthReleaseSSOT.ts");
  const dispose = await read("_shared/terminalTripPaymentDisposition.ts");
  for (const [name, src] of [
    ["revolutCompletionCapture", completion],
    ["adminCaptureTripPaymentSSOT", adminSsot],
    ["revolutPreauthReleaseSSOT", release],
    ["terminalTripPaymentDisposition", dispose],
  ] as const) {
    assertStringIncludes(src, "assertFareCaptureAllowedAtProvider", name);
  }

  // Raw provider helper itself must not be imported by channel booking UI Edge wrappers above;
  // only the four gated modules above (+ revolutOrders definition) call it.
  const orders = await read("_shared/revolutOrders.ts");
  assertStringIncludes(orders, "export async function captureRevolutOrder");
});

Deno.test("channel lock: cancel/fee paths stay on terminal_fee; unexpected early capture not normal paid", async () => {
  const cancel = await read("cancel-trip/index.ts");
  assertStringIncludes(cancel, "disposeTerminalTripPayment");
  assertEquals(cancel.includes("captureRevolutOrder"), false);

  const fee = await read("charge-lifecycle-fee/index.ts");
  assertStringIncludes(fee, "releaseRevolutPreauthForTrip");
  assertEquals(fee.includes("captureRevolutOrder"), false);

  const webhook = await read("revolut-webhook/index.ts");
  assertStringIncludes(webhook, "handleRevolutPaymentInvariantViolation");
  assertStringIncludes(webhook, "capture_before_trip_completion");
  assertStringIncludes(webhook, "skip trip payment_status=captured before completion");
  // Premature COMPLETED must not keep effectiveStatus as captured for live trips.
  assertStringIncludes(webhook, 'effectiveStatus = "authorized"');

  const release = await read("_shared/revolutPreauthReleaseSSOT.ts");
  assertStringIncludes(release, "payment_invariant_violation");
  assertStringIncludes(release, "refunded_wrong_capture");
  // Invariant path marks refunded / orphan — never payment_status captured as normal paid.
  assertStringIncludes(release, 'payment_status: "refunded"');
});
