/**
 * #89D — Preauth must refuse NEW Revolut auth on passenger schedule overlap.
 * Orphan cleanup remains secondary; primary prevention is pre-provider gate.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolvePreauthCandidateSchedule,
  PREAUTH_BOOKING_TIME_CONFLICT,
} from "../../functions/_shared/preauthPassengerOverlapGateSSOT.ts";
import { findPassengerScheduleOverlap } from "../../functions/_shared/passengerScheduleOverlapSSOT.ts";

const EXISTING = [{
  id: "trip-primary",
  scheduled_at: "2026-11-25T06:40:00.000Z",
  estimated_duration_minutes: 45,
  status: "scheduled",
  passenger_id: "user-1",
  created_at: "2026-11-24T13:39:10.422Z",
  is_scheduled: true,
}];

Deno.test("#89D overlapping scheduled retry conflicts before provider auth", () => {
  const schedule = resolvePreauthCandidateSchedule({
    is_scheduled: true,
    scheduled_at: "2026-11-25T06:45:00.000Z",
    estimated_duration_minutes: 40,
    client_action_id: "new-cai",
  });
  assertEquals(schedule.candidateIsImmediate, false);
  const overlap = findPassengerScheduleOverlap({
    candidateScheduledAt: schedule.candidateScheduledAt,
    candidateIsImmediate: schedule.candidateIsImmediate,
    candidateDurationMinutes: schedule.candidateDurationMinutes,
    existing: EXISTING,
  });
  assertEquals(overlap.has_conflict, true);
  if (overlap.has_conflict) {
    assertEquals(overlap.conflicting_trip_id, "trip-primary");
    assertEquals(overlap.code, PREAUTH_BOOKING_TIME_CONFLICT);
  }
});

Deno.test("#89D non-overlapping later schedule is allowed", () => {
  const overlap = findPassengerScheduleOverlap({
    candidateScheduledAt: "2026-11-26T12:00:00.000Z",
    candidateIsImmediate: false,
    candidateDurationMinutes: 30,
    existing: EXISTING,
  });
  assertEquals(overlap.has_conflict, false);
});

Deno.test("#89D same-trip reauth excludes primary trip id", () => {
  const overlap = findPassengerScheduleOverlap({
    candidateScheduledAt: "2026-11-25T06:40:00.000Z",
    candidateIsImmediate: false,
    candidateDurationMinutes: 45,
    existing: EXISTING,
    excludeTripId: "trip-primary",
  });
  assertEquals(overlap.has_conflict, false);
});

Deno.test("#89D immediate NOW conflicts with overlapping scheduled trip", () => {
  const nowMs = Date.parse("2026-11-25T06:50:00.000Z");
  const overlap = findPassengerScheduleOverlap({
    candidateScheduledAt: null,
    candidateIsImmediate: true,
    candidateDurationMinutes: 30,
    existing: EXISTING,
    nowMs,
  });
  assertEquals(overlap.has_conflict, true);
});

Deno.test("#89D booking_snapshot scheduled_at is resolved", () => {
  const schedule = resolvePreauthCandidateSchedule({
    booking_snapshot: {
      scheduled_at: "2026-11-25T08:00:00.000Z",
      is_scheduled: true,
      estimated_duration_minutes: 25,
    },
  });
  assertEquals(schedule.candidateScheduledAt, "2026-11-25T08:00:00.000Z");
  assertEquals(schedule.candidateIsImmediate, false);
  assertEquals(schedule.candidateDurationMinutes, 25);
});

Deno.test("#89D create-preauth wires overlap gate before Revolut", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/create-preauth-payment-intent/index.ts", import.meta.url),
  );
  assertEquals(src.includes("assertPassengerClearForNewPreauth"), true);
  assertEquals(src.includes("PREAUTH_SCHEDULE_OVERLAP_BLOCKED"), true);
  assertEquals(src.includes("customerId: dbCustomerForSessionId"), true);
  const gateIdx = src.indexOf("assertPassengerClearForNewPreauth");
  const revolutIdx = src.indexOf("await createRevolutPreauthResponse({");
  assertEquals(gateIdx > 0 && revolutIdx > gateIdx, true);
});

Deno.test("#89D gate resolves customers.id (not auth user) for trip passenger_id", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/preauthPassengerOverlapGateSSOT.ts", import.meta.url),
  );
  assertEquals(src.includes('from("customers")'), true);
  assertEquals(src.includes('.in("passenger_id", passengerKeys)'), true);
  assertEquals(src.includes("trips.passenger_id is customers.id"), true);
});

Deno.test("#89D tripless orphan claim refuses sessions linked to a trip", async () => {
  const mig = await Deno.readTextFile(
    new URL(
      "../../migrations/20270228160000_tripless_release_claim_state_fix.sql",
      import.meta.url,
    ),
  );
  assertEquals(mig.includes("has_trip"), true);
  assertEquals(mig.includes("trip_id IS NULL"), true);
  const hold = await Deno.readTextFile(
    new URL("../../functions/_shared/holdReleaseSSOT.ts", import.meta.url),
  );
  assertEquals(hold.includes("session_linked_to_trip"), true);
  assertEquals(hold.includes("Do NOT void the linked booking"), true);
});

Deno.test("#89D completion capture consumes frozen buffer policy", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  assertEquals(src.includes("resolveFrozenPreauthBufferPence"), true);
  assertEquals(src.includes("parseBookingFinancialPolicy"), true);
  assertEquals(src.includes("resolvePreauthBuffer"), false);
  assertEquals(src.includes('from("service_area_preauth_settings")'), false);
});

Deno.test("#89D missing-TEN recovery remains wired in sweep", async () => {
  const sweep = await Deno.readTextFile(
    new URL("../../functions/sweep-revolut-stale-holds/index.ts", import.meta.url),
  );
  assertEquals(sweep.includes("sweepRecoverMissingTripEarningNet"), true);
});
