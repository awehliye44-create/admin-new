import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import {
  CUSTOMER_SCHEDULED_OVERLAP_MESSAGE,
  DEFAULT_SCHEDULED_OVERLAP_BUFFER_MINUTES,
  DRIVER_SCHEDULED_OVERLAP_MESSAGE,
  evaluateTripScheduleOverlap,
  intervalsOverlapHalfOpen,
  resolveScheduledOverlapBufferMinutes,
  scheduledProtectedWindowMs,
  SCHEDULED_TRIP_OVERLAP_ERROR,
} from "../../functions/_shared/tripScheduleOverlapSSOT.ts";

const BUF = 30;

Deno.test("resolve buffer: null/invalid → 30", () => {
  assertEquals(resolveScheduledOverlapBufferMinutes(null), 30);
  assertEquals(resolveScheduledOverlapBufferMinutes(undefined), 30);
  assertEquals(resolveScheduledOverlapBufferMinutes(-1), 30);
  assertEquals(resolveScheduledOverlapBufferMinutes(999), 30);
  assertEquals(resolveScheduledOverlapBufferMinutes(30), 30);
  assertEquals(resolveScheduledOverlapBufferMinutes(45), 45);
});

Deno.test("default buffer constant is 30", () => {
  assertEquals(DEFAULT_SCHEDULED_OVERLAP_BUFFER_MINUTES, 30);
});

Deno.test("protected window: 14:00 + 45m duration → 13:30–15:15", () => {
  const win = scheduledProtectedWindowMs({
    scheduledAtIso: "2026-09-17T14:00:00.000Z",
    estimatedDurationMinutes: 45,
    bufferMinutes: BUF,
  });
  assertEquals(win!.startMs, Date.parse("2026-09-17T13:30:00.000Z"));
  assertEquals(win!.endMs, Date.parse("2026-09-17T15:15:00.000Z"));
});

Deno.test("no overlap — far apart", () => {
  const r = evaluateTripScheduleOverlap({
    candidateMode: "scheduled",
    candidateStartIso: "2026-09-17T18:00:00.000Z",
    candidateDurationMinutes: 30,
    bufferMinutes: BUF,
    existing: [{
      id: "A",
      scheduled_at: "2026-09-17T14:00:00.000Z",
      estimated_duration_minutes: 45,
      status: "scheduled",
    }],
  });
  assertEquals(r.conflict, false);
});

Deno.test("overlap at beginning", () => {
  // Existing protected 13:30–15:15; candidate 13:00+30m → protected 12:30–14:00 overlaps
  const r = evaluateTripScheduleOverlap({
    candidateMode: "scheduled",
    candidateStartIso: "2026-09-17T13:00:00.000Z",
    candidateDurationMinutes: 30,
    bufferMinutes: BUF,
    existing: [{
      id: "A",
      scheduled_at: "2026-09-17T14:00:00.000Z",
      estimated_duration_minutes: 45,
      status: "accepted",
    }],
  });
  assertEquals(r.conflict, true);
  assertEquals(r.conflicting_trip_id, "A");
  assertEquals(r.reason, SCHEDULED_TRIP_OVERLAP_ERROR);
});

Deno.test("overlap at end", () => {
  // Candidate 15:00+30 → protected 14:30–16:00 overlaps 13:30–15:15
  const r = evaluateTripScheduleOverlap({
    candidateMode: "scheduled",
    candidateStartIso: "2026-09-17T15:00:00.000Z",
    candidateDurationMinutes: 30,
    bufferMinutes: BUF,
    existing: [{
      id: "A",
      scheduled_at: "2026-09-17T14:00:00.000Z",
      estimated_duration_minutes: 45,
      status: "scheduled",
    }],
  });
  assertEquals(r.conflict, true);
});

Deno.test("fully contained interval conflicts", () => {
  const r = evaluateTripScheduleOverlap({
    candidateMode: "scheduled",
    candidateStartIso: "2026-09-17T14:10:00.000Z",
    candidateDurationMinutes: 10,
    bufferMinutes: BUF,
    existing: [{
      id: "A",
      scheduled_at: "2026-09-17T14:00:00.000Z",
      estimated_duration_minutes: 45,
      status: "scheduled",
    }],
  });
  assertEquals(r.conflict, true);
});

Deno.test("identical interval conflicts", () => {
  const r = evaluateTripScheduleOverlap({
    candidateMode: "scheduled",
    candidateStartIso: "2026-09-17T14:00:00.000Z",
    candidateDurationMinutes: 45,
    bufferMinutes: BUF,
    existing: [{
      id: "A",
      scheduled_at: "2026-09-17T14:00:00.000Z",
      estimated_duration_minutes: 45,
      status: "scheduled",
    }],
  });
  assertEquals(r.conflict, true);
});

Deno.test("exact boundary allowed (protected end == next protected start)", () => {
  // A: 14:00+45 → protected end 15:15
  // B: start so protected start == 15:15 → scheduled_at = 15:45
  const r = evaluateTripScheduleOverlap({
    candidateMode: "scheduled",
    candidateStartIso: "2026-09-17T15:45:00.000Z",
    candidateDurationMinutes: 30,
    bufferMinutes: BUF,
    existing: [{
      id: "A",
      scheduled_at: "2026-09-17T14:00:00.000Z",
      estimated_duration_minutes: 45,
      status: "scheduled",
    }],
  });
  assertEquals(r.conflict, false);
});

Deno.test("cancelled / completed do not block", () => {
  for (const status of ["cancelled", "completed", "expired", "no_show"]) {
    const r = evaluateTripScheduleOverlap({
      candidateMode: "scheduled",
      candidateStartIso: "2026-09-17T14:00:00.000Z",
      candidateDurationMinutes: 45,
      bufferMinutes: BUF,
      existing: [{
        id: "A",
        scheduled_at: "2026-09-17T14:00:00.000Z",
        estimated_duration_minutes: 45,
        status,
      }],
    });
    assertEquals(r.conflict, false, status);
  }
});

Deno.test("immediate vs scheduled: finish before protected start allowed", () => {
  // Scheduled 14:00 → protected start 13:30
  // NOW ends 13:25 → eligible
  const r = evaluateTripScheduleOverlap({
    candidateMode: "immediate",
    candidateStartIso: "2026-09-17T12:40:00.000Z",
    candidateEstimatedEndIso: "2026-09-17T13:25:00.000Z",
    bufferMinutes: BUF,
    existing: [{
      id: "S",
      scheduled_at: "2026-09-17T14:00:00.000Z",
      estimated_duration_minutes: 45,
      status: "accepted",
    }],
  });
  assertEquals(r.conflict, false);
});

Deno.test("immediate vs scheduled: exact protected start boundary allowed", () => {
  const r = evaluateTripScheduleOverlap({
    candidateMode: "immediate",
    candidateStartIso: "2026-09-17T12:40:00.000Z",
    candidateEstimatedEndIso: "2026-09-17T13:30:00.000Z",
    bufferMinutes: BUF,
    existing: [{
      id: "S",
      scheduled_at: "2026-09-17T14:00:00.000Z",
      estimated_duration_minutes: 45,
      status: "accepted",
    }],
  });
  assertEquals(r.conflict, false);
});

Deno.test("immediate vs scheduled: 1 minute into protection blocks", () => {
  const r = evaluateTripScheduleOverlap({
    candidateMode: "immediate",
    candidateStartIso: "2026-09-17T12:40:00.000Z",
    candidateEstimatedEndIso: "2026-09-17T13:31:00.000Z",
    bufferMinutes: BUF,
    existing: [{
      id: "S",
      scheduled_at: "2026-09-17T14:00:00.000Z",
      estimated_duration_minutes: 45,
      status: "accepted",
    }],
  });
  assertEquals(r.conflict, true);
  assertEquals(r.conflicting_trip_id, "S");
});

Deno.test("DST-safe: Europe/London spring-forward wall times as UTC instants", () => {
  // Use absolute UTC instants — buffer math is duration-based, not wall-clock.
  const r = evaluateTripScheduleOverlap({
    candidateMode: "scheduled",
    candidateStartIso: "2026-03-29T01:30:00.000Z",
    candidateDurationMinutes: 60,
    bufferMinutes: BUF,
    existing: [{
      id: "A",
      scheduled_at: "2026-03-29T00:00:00.000Z",
      estimated_duration_minutes: 30,
      status: "scheduled",
    }],
  });
  // A protected: 23:30 prev – 01:00; B protected: 01:00 – 03:00 → boundary at 01:00 allowed
  assertEquals(r.conflict, false);
});

Deno.test("interval helper boundary", () => {
  assertEquals(intervalsOverlapHalfOpen(0, 10, 10, 20), false);
  assertEquals(intervalsOverlapHalfOpen(0, 10, 9, 20), true);
});

Deno.test("UX copy constants locked", () => {
  assertEquals(
    DRIVER_SCHEDULED_OVERLAP_MESSAGE,
    "You already have a booking that conflicts with this time.",
  );
  assertEquals(
    CUSTOMER_SCHEDULED_OVERLAP_MESSAGE,
    "You already have a booking that conflicts with this time. Please choose another time.",
  );
});
