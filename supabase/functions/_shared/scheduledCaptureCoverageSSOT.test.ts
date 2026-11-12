import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateCaptureDeadlineCoverage,
  mergeCaptureDeadlinePersistence,
  isCardFundedPaymentMethod,
} from "./scheduledCaptureCoverageSSOT.ts";

const pickup = "2026-06-10T15:00:00.000Z";
const duration = 40;
const requiredMs = Date.parse(pickup) + (40 + 360) * 60_000;

Deno.test("authorisation valid at booking but expires before expected completion → insufficient", () => {
  const deadline = new Date(Date.parse(pickup) + 30 * 60_000).toISOString();
  const r = evaluateCaptureDeadlineCoverage({
    scheduledAtIso: pickup,
    estimatedDurationMinutes: duration,
    captureDeadlineIso: deadline,
    session: { status: "authorised", provider_state: "AUTHORISED" },
  });
  assertEquals(r.verdict, "insufficient");
  assertEquals(r.definitive, true);
  assertEquals(r.covered, false);
});

Deno.test("deadline exactly at required horizon is covered", () => {
  const deadline = new Date(requiredMs).toISOString();
  const r = evaluateCaptureDeadlineCoverage({
    scheduledAtIso: pickup,
    estimatedDurationMinutes: duration,
    captureDeadlineIso: deadline,
    session: { status: "authorised", provider_state: "AUTHORISED" },
  });
  assertEquals(r.verdict, "covered");
  assertEquals(r.covered, true);
});

Deno.test("missing deadline is non-definitive (retrieve required)", () => {
  const r = evaluateCaptureDeadlineCoverage({
    scheduledAtIso: pickup,
    estimatedDurationMinutes: duration,
    captureDeadlineIso: null,
    session: { status: "authorised", provider_state: "AUTHORISED" },
  });
  assertEquals(r.verdict, "deadline_missing");
  assertEquals(r.definitive, false);
});

Deno.test("mergeCaptureDeadline never overwrites valid with NULL", () => {
  const existing = "2026-06-11T12:00:00.000Z";
  const merged = mergeCaptureDeadlinePersistence({
    existingDeadlineIso: existing,
    providerDeadlineRaw: null,
    source: "provider_webhook",
  });
  assertEquals(merged.captureDeadlineIso, new Date(existing).toISOString());
  assertEquals(merged.changed, false);
});

Deno.test("mergeCaptureDeadline refreshes when provider returns new value", () => {
  const existing = "2026-06-11T12:00:00.000Z";
  const next = "2026-06-12T18:00:00.000Z";
  const merged = mergeCaptureDeadlinePersistence({
    existingDeadlineIso: existing,
    providerDeadlineRaw: next,
    source: "provider_retrieve",
  });
  assertEquals(merged.captureDeadlineIso, new Date(next).toISOString());
  assertEquals(merged.changed, true);
});

Deno.test("delayed pickup extends required coverage horizon", () => {
  const earlyDeadline = new Date(requiredMs).toISOString();
  const delayedPickup = "2026-06-10T18:00:00.000Z";
  const r = evaluateCaptureDeadlineCoverage({
    scheduledAtIso: delayedPickup,
    estimatedDurationMinutes: duration,
    captureDeadlineIso: earlyDeadline,
    session: { status: "authorised", provider_state: "AUTHORISED" },
  });
  assertEquals(r.verdict, "insufficient");
});

Deno.test("stale/superseded session is definitive failure", () => {
  const r = evaluateCaptureDeadlineCoverage({
    scheduledAtIso: pickup,
    estimatedDurationMinutes: duration,
    captureDeadlineIso: new Date(requiredMs + 60_000).toISOString(),
    session: {
      status: "payment_orphaned",
      provider_state: "AUTHORISED",
      metadata: { never_capture: true },
    },
  });
  assertEquals(r.verdict, "session_invalid");
  assertEquals(r.definitive, true);
});

Deno.test("session bound to other trip is rejected", () => {
  const r = evaluateCaptureDeadlineCoverage({
    scheduledAtIso: pickup,
    estimatedDurationMinutes: duration,
    captureDeadlineIso: new Date(requiredMs + 60_000).toISOString(),
    expectedTripId: "trip-a",
    session: {
      status: "authorised",
      provider_state: "AUTHORISED",
      trip_id: "trip-b",
    },
  });
  assertEquals(r.verdict, "session_invalid");
  assertEquals(r.code, "SESSION_TRIP_MISMATCH");
});

Deno.test("card-funded methods require coverage; cash does not", () => {
  assertEquals(isCardFundedPaymentMethod("card"), true);
  assertEquals(isCardFundedPaymentMethod("APPLE_PAY"), true);
  assertEquals(isCardFundedPaymentMethod("cash"), false);
  assertEquals(isCardFundedPaymentMethod("DRIVER_WALLET"), false);
});
