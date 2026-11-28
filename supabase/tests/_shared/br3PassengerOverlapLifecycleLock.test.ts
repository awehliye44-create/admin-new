/**
 * BR3 — terminal lifecycle must not retain passenger schedule overlap.
 * Includes exact MK-261127-005 fixture reproduction.
 *
 * Run: deno test --allow-read supabase/tests/_shared/br3PassengerOverlapLifecycleLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isPassengerOverlapEligibleTripStatus,
  isPassengerOverlapTerminalTripStatus,
  PASSENGER_OVERLAP_TERMINAL_STATUS_POSTGREST_LIST,
  PASSENGER_OVERLAP_TERMINAL_TRIP_STATUSES,
} from "./offline/passengerBookingOverlapLifecycleSSOT.ts";
import { findPassengerScheduleOverlap } from "../../functions/_shared/passengerScheduleOverlapSSOT.ts";
import { findCorporateScheduleOverlap } from "../../functions/_shared/corporateScheduleOverlapSSOT.ts";
import {
  BOOKING_TIME_CONFLICT_CUSTOMER_MESSAGE,
  BOOKING_TIME_CONFLICT_CUSTOMER_TITLE,
} from "../../functions/_shared/preauthPassengerOverlapGateSSOT.ts";

const root = new URL("../../functions/", import.meta.url);

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, root));
}

/** Exact MK-261127-005 production shape (CU065). */
const TRIP_005 = {
  id: "3944d88e-d1e9-4b2d-bc2b-95b15cf2a34e",
  scheduled_at: "2026-11-28T06:45:00.000Z",
  estimated_duration_minutes: 40,
  status: "expired",
  created_at: "2026-11-27T21:41:13.627Z",
  is_scheduled: true,
};

Deno.test("BR3: inventory includes expired / expired_no_driver / cancel variants", () => {
  for (const s of [
    "expired",
    "expired_no_driver",
    "cancelled",
    "canceled",
    "customer_cancelled",
    "completed",
    "no_show",
    "failed",
    "discarded",
    "admin_cancelled",
    "driver_cancelled",
  ]) {
    assertEquals(isPassengerOverlapTerminalTripStatus(s), true, s);
    assertEquals(isPassengerOverlapEligibleTripStatus(s), false, s);
  }
  for (const s of ["scheduled", "searching", "accepted", "en_route", "in_progress", "admin_held"]) {
    assertEquals(isPassengerOverlapEligibleTripStatus(s), true, s);
  }
  assertStringIncludes(PASSENGER_OVERLAP_TERMINAL_STATUS_POSTGREST_LIST, '"expired"');
  assertEquals(PASSENGER_OVERLAP_TERMINAL_TRIP_STATUSES.has("expired"), true);
});

Deno.test("BR3 MK-261127-005: expired scheduled cannot block instant Book in historical window", () => {
  for (const t of [
    "2026-11-28T06:27:12.000Z",
    "2026-11-28T06:47:28.000Z",
    "2026-11-28T07:20:00.000Z",
  ]) {
    const r = findPassengerScheduleOverlap({
      candidateScheduledAt: null,
      candidateIsImmediate: true,
      candidateDurationMinutes: 40,
      nowMs: Date.parse(t),
      existing: [TRIP_005],
    });
    assertEquals(r.has_conflict, false, t);
  }
});

Deno.test("BR3: expired instant cannot block subsequent NOW booking", () => {
  const r = findPassengerScheduleOverlap({
    candidateScheduledAt: null,
    candidateIsImmediate: true,
    candidateDurationMinutes: 30,
    nowMs: Date.parse("2026-11-26T20:23:22.000Z"),
    existing: [{
      id: "017",
      scheduled_at: null,
      created_at: "2026-11-26T20:04:25.000Z",
      estimated_duration_minutes: 30,
      status: "expired",
    }],
  });
  assertEquals(r.has_conflict, false);
});

Deno.test("BR3: cancelled / completed / no_show scheduled release overlap immediately", () => {
  for (const status of ["cancelled", "completed", "no_show", "customer_cancelled"]) {
    const r = findPassengerScheduleOverlap({
      candidateScheduledAt: null,
      candidateIsImmediate: true,
      candidateDurationMinutes: 40,
      nowMs: Date.parse("2026-11-28T06:47:28.000Z"),
      existing: [{ ...TRIP_005, status }],
    });
    assertEquals(r.has_conflict, false, status);
  }
});

Deno.test("BR3: active rematch / scheduled still blocks genuine overlap", () => {
  const r = findPassengerScheduleOverlap({
    candidateScheduledAt: null,
    candidateIsImmediate: true,
    candidateDurationMinutes: 40,
    nowMs: Date.parse("2026-11-28T06:47:28.000Z"),
    existing: [{ ...TRIP_005, status: "scheduled" }],
  });
  assertEquals(r.has_conflict, true);
  if (r.has_conflict) {
    assertEquals(r.code, "BOOKING_TIME_CONFLICT");
    assertEquals(r.conflicting_trip_id, TRIP_005.id);
  }
});

Deno.test("BR3: active non-overlapping scheduled does not block", () => {
  const r = findPassengerScheduleOverlap({
    candidateScheduledAt: null,
    candidateIsImmediate: true,
    candidateDurationMinutes: 30,
    nowMs: Date.parse("2026-11-28T12:00:00.000Z"),
    existing: [{ ...TRIP_005, status: "scheduled" }],
  });
  assertEquals(r.has_conflict, false);
});

Deno.test("BR3: scheduled↔scheduled ignores expired peer", () => {
  const r = findCorporateScheduleOverlap({
    candidateScheduledAt: "2026-11-28T06:45:00.000Z",
    candidateDurationMinutes: 40,
    existing: [TRIP_005],
  });
  assertEquals(r.has_conflict, false);
});

Deno.test("BR3: customer conflict copy is booking-shaped, not payment auth", () => {
  assertEquals(BOOKING_TIME_CONFLICT_CUSTOMER_TITLE, "Booking time conflict");
  assertStringIncludes(BOOKING_TIME_CONFLICT_CUSTOMER_MESSAGE, "active booking that overlaps");
  assertEquals(/authoris|Apple Pay|bank|payment wasn/i.test(BOOKING_TIME_CONFLICT_CUSTOMER_MESSAGE), false);
});

Deno.test("BR3: preauth / CTAP / validate / corporate wire DB terminal filter", async () => {
  const preauth = await read("_shared/preauthPassengerOverlapGateSSOT.ts");
  assertStringIncludes(preauth, "PASSENGER_OVERLAP_TERMINAL_STATUS_POSTGREST_LIST");
  assertStringIncludes(preauth, 'not("status", "in"');
  assertStringIncludes(preauth, "BOOKING_TIME_CONFLICT_CUSTOMER_MESSAGE");
  assertStringIncludes(preauth, "booking_conflict");

  const ctap = await read("create-trip-after-payment/index.ts");
  assertStringIncludes(ctap, "PASSENGER_OVERLAP_TERMINAL_STATUS_POSTGREST_LIST");
  assertStringIncludes(ctap, "BOOKING_TIME_CONFLICT_CUSTOMER_MESSAGE");

  const validate = await read("validate-scheduled-booking/index.ts");
  assertStringIncludes(validate, "PASSENGER_OVERLAP_TERMINAL_STATUS_POSTGREST_LIST");

  const corpBook = await read("create-corporate-book/index.ts");
  assertStringIncludes(corpBook, "PASSENGER_OVERLAP_TERMINAL_STATUS_POSTGREST_LIST");

  const corpCheck = await read("check-corporate-schedule-overlap/index.ts");
  assertStringIncludes(corpCheck, "PASSENGER_OVERLAP_TERMINAL_STATUS_POSTGREST_LIST");

  const createPreauth = await read("create-preauth-payment-intent/index.ts");
  assertStringIncludes(createPreauth, "assertPassengerClearForNewPreauth");
});

Deno.test("BR3: NOW path never lets scheduled_at bypass terminal status", async () => {
  const src = await read("_shared/passengerScheduleOverlapSSOT.ts");
  assertStringIncludes(src, "isPassengerOverlapEligibleTripStatus(trip.status)");
  // scheduled_at branch must come AFTER lifecycle gate.
  const gateIdx = src.indexOf("isPassengerOverlapEligibleTripStatus(trip.status)");
  const schedIdx = src.indexOf("if (trip.scheduled_at)");
  assertEquals(gateIdx >= 0 && schedIdx > gateIdx, true);
});
