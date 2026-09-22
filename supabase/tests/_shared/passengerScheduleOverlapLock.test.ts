/**
 * Passenger schedule overlap lock — actual expected intervals, not min-advance.
 *
 * Run: deno test --allow-read supabase/tests/_shared/passengerScheduleOverlapLock.test.ts
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { findPassengerScheduleOverlap } from "../../functions/_shared/passengerScheduleOverlapSSOT.ts";

Deno.test("overlap: non-overlapping scheduled bookings allowed", () => {
  const result = findPassengerScheduleOverlap({
    candidateScheduledAt: "2026-09-21T16:00:00.000Z",
    candidateDurationMinutes: 30,
    existing: [
      {
        id: "t1",
        scheduled_at: "2026-09-21T14:00:00.000Z",
        estimated_duration_minutes: 30,
        status: "scheduled",
      },
    ],
  });
  assertEquals(result.has_conflict, false);
});

Deno.test("overlap: overlapping scheduled bookings blocked", () => {
  const result = findPassengerScheduleOverlap({
    candidateScheduledAt: "2026-09-21T14:20:00.000Z",
    candidateDurationMinutes: 30,
    existing: [
      {
        id: "t1",
        scheduled_at: "2026-09-21T14:00:00.000Z",
        estimated_duration_minutes: 40,
        status: "admin_held",
      },
    ],
  });
  assertEquals(result.has_conflict, true);
  if (result.has_conflict) {
    assertEquals(result.code, "BOOKING_TIME_CONFLICT");
    assertEquals(result.conflicting_trip_id, "t1");
  }
});

Deno.test("overlap: min-advance alone is not treated as conflict (far future OK)", () => {
  // Candidate only 25 min out — advance is a separate check. Overlap math alone
  // does not reject a lone booking with no existing trips.
  const result = findPassengerScheduleOverlap({
    candidateScheduledAt: "2026-09-21T12:25:00.000Z",
    candidateDurationMinutes: 20,
    existing: [],
    nowMs: Date.parse("2026-09-21T12:00:00.000Z"),
  });
  assertEquals(result.has_conflict, false);
});

Deno.test("overlap: NOW vs nearby scheduled blocks when intervals collide", () => {
  const result = findPassengerScheduleOverlap({
    candidateScheduledAt: null,
    candidateIsImmediate: true,
    candidateDurationMinutes: 40,
    nowMs: Date.parse("2026-09-21T13:50:00.000Z"),
    existing: [
      {
        id: "sched-1",
        scheduled_at: "2026-09-21T14:00:00.000Z",
        estimated_duration_minutes: 30,
        status: "admin_held",
      },
    ],
  });
  assertEquals(result.has_conflict, true);
});
