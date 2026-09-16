import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import {
  findCorporateScheduleOverlap,
  isCorporateOverlapCandidateStatus,
  windowsOverlap,
} from "../../functions/_shared/corporateScheduleOverlapSSOT.ts";

Deno.test("exact overlap conflicts", () => {
  const r = findCorporateScheduleOverlap({
    candidateScheduledAt: "2026-09-15T12:00:00.000Z",
    candidateDurationMinutes: 30,
    existing: [{
      id: "t1",
      scheduled_at: "2026-09-15T12:00:00.000Z",
      estimated_duration_minutes: 30,
      status: "scheduled",
    }],
  });
  assertEquals(r.has_conflict, true);
});

Deno.test("partial overlap conflicts", () => {
  const r = findCorporateScheduleOverlap({
    candidateScheduledAt: "2026-09-15T12:20:00.000Z",
    candidateDurationMinutes: 30,
    existing: [{
      id: "t1",
      scheduled_at: "2026-09-15T12:00:00.000Z",
      estimated_duration_minutes: 30,
      status: "scheduled",
    }],
  });
  assertEquals(r.has_conflict, true);
});

Deno.test("boundary-touching outside buffer does not conflict (end == start after buffer math)", () => {
  // Without buffer, 12:00+30m ends 12:30; next at 12:30 touches.
  // With ±15m buffer they DO conflict — policy uses buffer.
  const r = findCorporateScheduleOverlap({
    candidateScheduledAt: "2026-09-15T12:30:00.000Z",
    candidateDurationMinutes: 30,
    existing: [{
      id: "t1",
      scheduled_at: "2026-09-15T12:00:00.000Z",
      estimated_duration_minutes: 30,
      status: "scheduled",
    }],
  });
  assertEquals(r.has_conflict, true);
});

Deno.test("far apart jobs do not conflict", () => {
  const r = findCorporateScheduleOverlap({
    candidateScheduledAt: "2026-09-15T18:00:00.000Z",
    candidateDurationMinutes: 30,
    existing: [{
      id: "t1",
      scheduled_at: "2026-09-15T12:00:00.000Z",
      estimated_duration_minutes: 30,
      status: "scheduled",
    }],
  });
  assertEquals(r.has_conflict, false);
});

Deno.test("cancelled and completed jobs ignored", () => {
  for (const status of ["cancelled", "completed"]) {
    const r = findCorporateScheduleOverlap({
      candidateScheduledAt: "2026-09-15T12:00:00.000Z",
      candidateDurationMinutes: 30,
      existing: [{
        id: "t1",
        scheduled_at: "2026-09-15T12:00:00.000Z",
        estimated_duration_minutes: 30,
        status,
      }],
    });
    assertEquals(r.has_conflict, false, status);
  }
});

Deno.test("status filter", () => {
  assertEquals(isCorporateOverlapCandidateStatus("scheduled"), true);
  assertEquals(isCorporateOverlapCandidateStatus("cancelled"), false);
});

Deno.test("DST-safe absolute instants: same UTC windows conflict regardless of local label", () => {
  // Europe/London BST vs GMT — compare absolute ISO instants only.
  const r = findCorporateScheduleOverlap({
    candidateScheduledAt: "2026-03-29T01:30:00.000Z",
    candidateDurationMinutes: 60,
    existing: [{
      id: "t1",
      scheduled_at: "2026-03-29T01:00:00.000Z",
      estimated_duration_minutes: 60,
      status: "scheduled",
    }],
  });
  assertEquals(r.has_conflict, true);
});

Deno.test("windowsOverlap half-open semantics helper", () => {
  assertEquals(windowsOverlap(0, 10, 10, 20), false);
  assertEquals(windowsOverlap(0, 11, 10, 20), true);
});
